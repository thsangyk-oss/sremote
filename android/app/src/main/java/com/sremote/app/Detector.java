package com.sremote.app;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Classifies a raw PTY stream into RUNNING / QUESTION / DONE.
 * Pure Java (no Android deps) so it can be unit-tested with plain javac.
 *
 * Signals, strongest first:
 *  - OSC 133;D[;code]       shell integration "command finished"
 *  - OSC 9;msg / OSC 777    explicit notifications (agents, scripts)
 *  - BEL                    classic "done / attention" bell
 *  - last screen lines      question prompts (y/n, menus, "...?"), shell prompt
 *  - output stall           long busy period that suddenly stops (TUI agents)
 * ConPTY repaints with cursor moves instead of newlines/spaces, so CSI H/d
 * become line breaks and CSI C becomes spaces before line analysis.
 */
final class Detector {
    enum State { IDLE, RUNNING, QUESTION, DONE, EXITED }

    static final class Answer {
        final String label, data;
        Answer(String l, String d) { label = l; data = d; }
    }

    static final class Event {
        final String kind;    // "question" | "done"
        final String reason;  // question: "prompt"|"notify" — done: "prompt"|"exit"|"bell"|"notify"|"stall"
        final String text;
        final int code;       // exit code for reason=exit, else -1
        Event(String k, String r, String t, int c) { kind = k; reason = r; text = t; code = c; }
    }

    // timings (ms)
    static final long QUESTION_QUIET = 1_200;   // output settled → look for a question
    static final long PROMPT_QUIET = 2_000;     // output settled on a shell prompt → done
    static final long STALL_QUIET = 10_000;     // long busy run that stopped → likely done
    static final long STALL_MIN_BUSY = 8_000;
    static final long BURST_GAP = 2_500;        // quiet gap separating output bursts
    static final long RUNNING_WINDOW = 3_000;
    static final long SIGNAL_THROTTLE = 20_000; // min gap between bell/notify-derived events
    static final int TAIL_MAX = 6_000;

    private static final Pattern P_YN = Pattern.compile(
            "(?i)(\\[\\s*(y|yes)\\s*/\\s*(n|no)\\s*\\]|\\(\\s*(y|yes)\\s*/\\s*(n|no)\\s*\\)|\\b(y/n|yes/no)\\b|\\(y\\)es)");
    private static final Pattern P_ASK = Pattern.compile(
            "(?i)(do you want|would you like|are you sure|shall i|should i|continue\\?|proceed\\?|overwrite.*\\?|"
            + "\\bconfirm\\b|\\bapprove\\b|allow (this|once|always)|(needs?|requests?|requesting|grant|asks? for) (your )?permission|"
            + "press (enter|return|any key)|"
            + "waiting for (your )?input|needs your (input|approval|attention)|select an option|choose an option)");
    private static final Pattern P_SECRET = Pattern.compile(
            "(?i)(password|passphrase|username|token|otp|verification code|pin)( for [^:]*)?\\s*:\\s*$");
    private static final Pattern P_MENU = Pattern.compile("^\\s*[❯>›»*]?\\s*(\\d)[.)]\\s+(.+)$");
    private static final Pattern P_ENTER = Pattern.compile("(?i)press (enter|return|any key)");
    private static final Pattern P_RUNNING_HINT = Pattern.compile(
            "(?i)(esc to (interrupt|cancel)|ctrl\\+c to (interrupt|cancel|stop)|press ctrl-c to stop)");

    // shell prompts: PowerShell, cmd, posix, fancy (starship/omz), python/node REPL
    private static final Pattern P_PROMPT = Pattern.compile(
            "^(PS [^>]{0,240}>|[A-Za-z]:\\\\[^>]{0,240}>|[^\\s].{0,160}[$#]|.{0,160}[❯➜λ»]|➜ .{0,160}|>>>|>)$");
    // a prompt followed by typed text — user input, never a question
    private static final Pattern P_PROMPT_INPUT = Pattern.compile(
            "^(PS [^>]{0,240}>|[A-Za-z]:\\\\[^>]{0,240}>|\\S{1,80}@\\S{1,80}[^$#]{0,120}[$#])\\s+\\S.*$");
    private static final Pattern P_DECOR = Pattern.compile("[\\u2500-\\u257F\\u2580-\\u259F]");

    // ---- parser state ----
    private final StringBuilder tail = new StringBuilder();
    private final StringBuilder osc = new StringBuilder();
    private final StringBuilder csi = new StringBuilder();
    private int esc;              // 0 text, 1 ESC, 2 CSI, 3 OSC, 4 OSC-ESC, 5 charset
    private boolean pendingCR;

    // ---- activity state ----
    private State state = State.IDLE;
    private long lastOut, busyStart, busyBytes, burstStart, sinceQuestionBytes, lastSignalAt;
    private boolean progress, dirty, questionCleared;
    private String lastQuestion;
    private Event pending;
    private String lastLine = "";

    State state() { return state; }
    String lastLine() { return lastLine; }
    /** text of the pending question while in QUESTION state */
    String question() { return state == State.QUESTION ? lastQuestion : null; }

    /** scrollback replay after attach: learn the screen, never fire */
    void seed(String data) {
        parse(data, 0);
        refreshLastLine();
        List<String> ls = lines(6);
        String q = questionText(ls);
        lastQuestion = q;
        pending = null;
        state = q != null ? State.QUESTION : State.IDLE;
        settle();
    }

    /** live output */
    void feed(String data, long now) {
        if (data.isEmpty()) return;
        if (now - lastOut > BURST_GAP) burstStart = now;
        if (busyStart == 0) busyStart = now;
        lastOut = now;
        int visible = parse(data, now);
        busyBytes += visible;
        dirty = true;
        if (state == State.QUESTION) {
            sinceQuestionBytes += visible;
            if (sinceQuestionBytes > 40) { state = State.RUNNING; questionCleared = true; lastQuestion = null; }
        } else if (busyBytes >= 200 || now - burstStart >= 1_500) {
            state = State.RUNNING;
        }
    }

    void exited() { state = State.EXITED; pending = null; }

    /** true once after a pending question got answered by new output */
    boolean takeQuestionCleared() { boolean c = questionCleared; questionCleared = false; return c; }

    /** evaluate timers; returns at most one event */
    Event tick(long now) {
        if (state == State.EXITED) return null;
        if (pending != null) {
            Event e = pending; pending = null;
            state = e.kind.equals("question") ? State.QUESTION : State.DONE;
            if (state == State.QUESTION) { lastQuestion = e.text; sinceQuestionBytes = 0; }
            settle();
            return e;
        }
        long quiet = now - lastOut;
        if (dirty) refreshLastLine(); // live preview for the UI
        if (lastOut == 0 || busyBytes == 0) return null;
        if (progress && quiet < STALL_QUIET * 3) return null;

        if (dirty && quiet >= QUESTION_QUIET) {
            refreshLastLine();
            List<String> ls = lines(6);
            if (!runningHint(ls)) {
                String q = questionText(ls);
                if (q != null && !q.equals(lastQuestion)) {
                    dirty = false;
                    lastQuestion = q; sinceQuestionBytes = 0;
                    state = State.QUESTION;
                    settle();
                    return new Event("question", "prompt", q, -1);
                }
                if (quiet >= PROMPT_QUIET && isPrompt(lastRaw()) && busyEnough()) {
                    dirty = false;
                    state = State.DONE;
                    String ctx = contextLine();
                    settle();
                    return new Event("done", "prompt", ctx, -1);
                }
            }
        }
        if (quiet >= STALL_QUIET && now - busyStart >= STALL_MIN_BUSY && busyBytes >= 1_000
                && state == State.RUNNING) {
            refreshLastLine();
            dirty = false;
            state = State.DONE;
            String ctx = contextLine();
            settle();
            return new Event("done", "stall", ctx, -1);
        }
        if (state == State.RUNNING && quiet > RUNNING_WINDOW && busyBytes < 200) state = State.IDLE;
        return null;
    }

    private boolean busyEnough() {
        return (lastOut - busyStart >= 5_000 && busyBytes >= 200) || busyBytes >= 4_000;
    }

    private void settle() { busyBytes = 0; busyStart = 0; }

    // ---------------- parser ----------------
    /** appends printable text to tail, handles escapes; returns visible char count */
    private int parse(String d, long now) {
        int vis = 0;
        for (int i = 0; i < d.length(); i++) {
            char ch = d.charAt(i);
            switch (esc) {
                case 1: // after ESC
                    if (ch == '[') { esc = 2; csi.setLength(0); }
                    else if (ch == ']') { esc = 3; osc.setLength(0); }
                    else if (ch == '(' || ch == ')' || ch == '*' || ch == '+') esc = 5;
                    else esc = 0;
                    continue;
                case 2: // CSI params until final byte
                    if (ch >= 0x40 && ch <= 0x7E) { esc = 0; onCsi(ch, csi.toString()); }
                    else if (csi.length() < 32) csi.append(ch);
                    continue;
                case 3: // OSC until BEL or ST
                    if (ch == 7) { esc = 0; onOsc(osc.toString(), now); }
                    else if (ch == 27) esc = 4;
                    else if (osc.length() < 1024) osc.append(ch);
                    continue;
                case 4:
                    esc = 0;
                    if (ch == '\\') onOsc(osc.toString(), now);
                    continue;
                case 5:
                    esc = 0;
                    continue;
            }
            if (ch == 27) { esc = 1; continue; }
            if (pendingCR) {
                pendingCR = false;
                if (ch != '\n') clearLine();
            }
            if (ch == '\r') { pendingCR = true; continue; }
            if (ch == '\n') { newline(); continue; }
            if (ch == 7) { onBell(now); continue; }
            if (ch == 8) { int n = tail.length(); if (n > 0 && tail.charAt(n - 1) != '\n') tail.setLength(n - 1); continue; }
            if (ch == '\t') { tail.append("    "); continue; }
            if (ch < 0x20) continue;
            tail.append(ch);
            vis++;
        }
        if (tail.length() > TAIL_MAX) {
            int cut = tail.indexOf("\n", tail.length() - TAIL_MAX);
            tail.delete(0, cut < 0 ? tail.length() - TAIL_MAX : cut + 1);
        }
        return vis;
    }

    private void newline() { tail.append('\n'); }

    private void clearLine() {
        int nl = tail.lastIndexOf("\n");
        tail.setLength(nl + 1);
    }

    private void onCsi(char fin, String params) {
        switch (fin) {
            case 'H': case 'f': case 'd': // absolute cursor moves → treat as line break
                if (tail.length() > 0 && tail.charAt(tail.length() - 1) != '\n') newline();
                break;
            case 'C': { // cursor forward → spaces (ConPTY uses this instead of blanks)
                int n = 1;
                try { if (!params.isEmpty()) n = Integer.parseInt(params); } catch (NumberFormatException ignored) {}
                for (int k = 0; k < Math.min(n, 8); k++) tail.append(' ');
                break;
            }
            case 'J': // clear screen → old lines are gone from the user's view too
                if (params.equals("2") || params.equals("3")) tail.setLength(0);
                break;
            case 'K':
                if (params.equals("2")) clearLine();
                break;
        }
    }

    private void onOsc(String s, long now) {
        if (s.startsWith("133;D")) {
            int code = -1;
            int sc = s.indexOf(';', 5);
            if (sc > 0) try { code = Integer.parseInt(s.substring(sc + 1).trim()); } catch (NumberFormatException ignored) {}
            if (busyBytes > 0 || state == State.RUNNING)
                pending = new Event("done", "exit", contextLine(), code);
            return;
        }
        if (s.startsWith("9;4;")) { // ConEmu/Windows Terminal progress
            progress = !(s.startsWith("9;4;0"));
            return;
        }
        String msg = null;
        if (s.startsWith("777;notify;")) msg = s.substring(11).replaceFirst(";", ": ");
        else if (s.startsWith("9;")) msg = s.substring(2);
        if (msg == null || msg.trim().isEmpty() || now - lastSignalAt < SIGNAL_THROTTLE && now > 0) return;
        lastSignalAt = now;
        msg = msg.trim();
        pending = isQuestionish(msg) ? new Event("question", "notify", msg, -1)
                                     : new Event("done", "notify", msg, -1);
    }

    private void onBell(long now) {
        if (now == 0 || now - lastSignalAt < SIGNAL_THROTTLE) return;
        lastSignalAt = now;
        refreshLastLine();
        String q = questionText(lines(6));
        pending = q != null ? new Event("question", "prompt", q, -1)
                            : new Event("done", "bell", contextLine(), -1);
    }

    // ---------------- line analysis ----------------
    /** last n meaningful lines, oldest first (decoration / empty lines dropped) */
    private List<String> lines(int n) {
        List<String> out = new ArrayList<>();
        int end = tail.length();
        while (end > 0 && out.size() < n) {
            int start = tail.lastIndexOf("\n", end - 1) + 1;
            String l = clean(tail.substring(start, end));
            if (!l.isEmpty()) out.add(0, l);
            end = start - 1;
        }
        return out;
    }

    private static String clean(String l) {
        String s = P_DECOR.matcher(l).replaceAll(" ").trim();
        if (s.equals(">") || s.equals("?") || s.startsWith("? for shortcuts")) return "";
        return s.replaceAll("\\s{2,}", "  ");
    }

    /** last raw line (prompts must be judged untrimmed of meaning but trimmed of spaces) */
    private String lastRaw() {
        List<String> l = lines(1);
        return l.isEmpty() ? "" : l.get(0);
    }

    private void refreshLastLine() {
        String l = lastRaw();
        if (!l.isEmpty()) lastLine = l.length() > 160 ? l.substring(0, 160) : l;
    }

    /** the most informative line before a trailing prompt */
    private String contextLine() {
        List<String> ls = lines(4);
        for (int i = ls.size() - 1; i >= 0; i--) {
            String l = ls.get(i);
            if (!isPrompt(l) && !P_PROMPT_INPUT.matcher(l).matches()) return trim(l);
        }
        return ls.isEmpty() ? "" : trim(ls.get(ls.size() - 1));
    }

    private static String trim(String s) { return s.length() > 200 ? s.substring(0, 200) + "…" : s; }

    static boolean isPrompt(String l) { return P_PROMPT.matcher(l.trim()).matches(); }

    private static boolean runningHint(List<String> ls) {
        for (String l : ls) if (P_RUNNING_HINT.matcher(l).find()) return true;
        return false;
    }

    static boolean isQuestionish(String s) {
        return P_YN.matcher(s).find() || P_ASK.matcher(s).find() || s.trim().endsWith("?");
    }

    /** question text from the last screen lines, or null */
    static String questionText(List<String> ls) {
        if (ls.isEmpty()) return null;
        String last = ls.get(ls.size() - 1);
        if (isPrompt(last) || P_PROMPT_INPUT.matcher(last).matches()) return null;
        // numbered menu ("❯ 1. Yes / 2. No") under a question line
        int menu = 0, firstMenu = -1;
        for (int i = 0; i < ls.size(); i++)
            if (P_MENU.matcher(ls.get(i)).matches()) { menu++; if (firstMenu < 0) firstMenu = i; }
        if (menu >= 2) {
            int from = Math.max(0, firstMenu - 1);
            return join(ls.subList(from, ls.size()));
        }
        if (P_SECRET.matcher(last).find()) return trim(last);
        int from = Math.max(0, ls.size() - 4);
        for (int i = ls.size() - 1; i >= from; i--) {
            String l = ls.get(i);
            boolean q = P_YN.matcher(l).find() || P_ASK.matcher(l).find()
                    || (l.endsWith("?") && l.length() >= 8);
            if (q) return join(ls.subList(Math.max(0, i - 1), ls.size()));
        }
        return null;
    }

    private static String join(List<String> ls) {
        StringBuilder b = new StringBuilder();
        for (String l : ls) { if (b.length() > 0) b.append('\n'); b.append(l); }
        return trim(b.toString());
    }

    /** quick-answer buttons inferred from the question */
    static List<Answer> answersFor(String q) {
        List<Answer> out = new ArrayList<>();
        if (q == null) return out;
        for (String l : q.split("\n")) {
            java.util.regex.Matcher m = P_MENU.matcher(l);
            if (m.matches() && out.size() < 2) {
                String label = m.group(2).trim();
                if (label.length() > 18) label = label.substring(0, 17) + "…";
                out.add(new Answer(m.group(1) + ". " + label, m.group(1)));
            }
        }
        if (!out.isEmpty()) return out;
        if (P_YN.matcher(q).find()) {
            out.add(new Answer("Yes", "y\r"));
            out.add(new Answer("No", "n\r"));
        } else if (P_ENTER.matcher(q).find()) {
            out.add(new Answer("Enter", "\r"));
        }
        return out;
    }
}
