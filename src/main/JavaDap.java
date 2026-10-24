import com.sun.jdi.*;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

// A Debug Adapter Protocol server for Java, built on the Java Debug Interface of the JDK (jdk.jdi): it starts the
// program with a debug agent, connects to it, and turns breakpoints, steps, variables and expressions into DAP.
// It is compiled by the editor with the user's javac, the first time a Java program is debugged.
public class JavaDap {
    // ---------------------------------------------------------------- JSON (just enough for the protocol)
    static final class Json {
        final String s; int i = 0;
        Json(String s) { this.s = s; }
        static Object parse(String s) { Json j = new Json(s); j.ws(); return j.value(); }
        void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
        Object value() {
            ws();
            char c = s.charAt(i);
            if (c == '{') {
                Map<String, Object> m = new LinkedHashMap<>(); i++; ws();
                if (s.charAt(i) == '}') { i++; return m; }
                for (;;) { ws(); String k = str(); ws(); i++; m.put(k, value()); ws(); if (s.charAt(i++) == '}') return m; }
            }
            if (c == '[') {
                List<Object> l = new ArrayList<>(); i++; ws();
                if (s.charAt(i) == ']') { i++; return l; }
                for (;;) { l.add(value()); ws(); if (s.charAt(i++) == ']') return l; }
            }
            if (c == '"') return str();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int st = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String n = s.substring(st, i);
            return n.contains(".") || n.contains("e") || n.contains("E") ? (Object) Double.valueOf(n) : (Object) Long.valueOf(n);
        }
        String str() {
            StringBuilder b = new StringBuilder(); i++;
            for (;;) {
                char c = s.charAt(i++);
                if (c == '"') return b.toString();
                if (c != '\\') { b.append(c); continue; }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': b.append('\n'); break; case 'r': b.append('\r'); break; case 't': b.append('\t'); break;
                    case 'b': b.append('\b'); break; case 'f': b.append('\f'); break;
                    case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: b.append(e);
                }
            }
        }
        static String write(Object o) { StringBuilder b = new StringBuilder(); write(b, o); return b.toString(); }
        @SuppressWarnings("unchecked")
        static void write(StringBuilder b, Object o) {
            if (o == null) b.append("null");
            else if (o instanceof String) quote(b, (String) o);
            else if (o instanceof Map) {
                b.append('{'); boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) { if (!first) b.append(','); first = false; quote(b, e.getKey()); b.append(':'); write(b, e.getValue()); }
                b.append('}');
            } else if (o instanceof List) {
                b.append('['); boolean first = true;
                for (Object x : (List<Object>) o) { if (!first) b.append(','); first = false; write(b, x); }
                b.append(']');
            } else b.append(o);
        }
        static void quote(StringBuilder b, String s) {
            b.append('"');
            for (int k = 0; k < s.length(); k++) {
                char c = s.charAt(k);
                switch (c) {
                    case '"': b.append("\\\""); break; case '\\': b.append("\\\\"); break; case '\n': b.append("\\n"); break;
                    case '\r': b.append("\\r"); break; case '\t': b.append("\\t"); break;
                    default: if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
                }
            }
            b.append('"');
        }
    }

    @SuppressWarnings("unchecked") static Map<String, Object> map(Object o) { return o instanceof Map ? (Map<String, Object>) o : new HashMap<>(); }
    @SuppressWarnings("unchecked") static List<Object> list(Object o) { return o instanceof List ? (List<Object>) o : new ArrayList<>(); }
    static String str(Object o) { return o == null ? null : String.valueOf(o); }
    static int num(Object o, int d) { return o instanceof Number ? ((Number) o).intValue() : d; }
    static Map<String, Object> obj(Object... kv) { Map<String, Object> m = new LinkedHashMap<>(); for (int k = 0; k + 1 < kv.length; k += 2) m.put((String) kv[k], kv[k + 1]); return m; }

    // ---------------------------------------------------------------- protocol i/o
    static PrintStream proto;
    static int seq = 1;
    static synchronized void send(Map<String, Object> m) {
        m.put("seq", seq++);
        byte[] body = Json.write(m).getBytes(StandardCharsets.UTF_8);
        byte[] head = ("Content-Length: " + body.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
        proto.write(head, 0, head.length);
        proto.write(body, 0, body.length);
        proto.flush();
    }
    static void event(String name, Map<String, Object> body) { send(obj("type", "event", "event", name, "body", body)); }
    static void respond(Map<String, Object> req, boolean ok, Map<String, Object> body, String message) {
        Map<String, Object> m = obj("type", "response", "request_seq", req.get("seq"), "success", ok, "command", req.get("command"));
        if (body != null) m.put("body", body);
        if (message != null) m.put("message", message);
        send(m);
    }
    static void output(String category, String text) { event("output", obj("category", category, "output", text)); }

    // ---------------------------------------------------------------- state
    static VirtualMachine vm;
    static Process proc;
    static final Object lock = new Object();
    static Map<String, Object> launchArgs = new HashMap<>();
    static Map<String, Object> pendingLaunch;
    static boolean stopOnEntry, terminated;
    static List<String> sourceRoots = new ArrayList<>();
    static String mainClass;
    static String exitCodeText;

    static final class Bp { int id; String file; int line; String condition; boolean verified; List<BreakpointRequest> reqs = new ArrayList<>(); }
    static final Map<String, List<Bp>> breakpoints = new HashMap<>(); // normalized file -> breakpoints
    static int nextBp = 1;
    static final Set<String> watchedSources = new HashSet<>();
    static ExceptionRequest exceptionRequest;

    // Handles for things the client expands: frames, objects, arrays.
    static final Map<Integer, Object> handles = new HashMap<>();
    static int nextHandle = 1;
    static int handle(Object o) { int h = nextHandle++; handles.put(h, o); return h; }
    // A frame is looked up again whenever it is used: calling a method in the program (to show a value) resumes the thread for a moment, which ends the life of every StackFrame object.
    static final class FrameRef {
        final ThreadReference thread; final int index;
        FrameRef(ThreadReference t, int i) { thread = t; index = i; }
        StackFrame get() throws IncompatibleThreadStateException { return thread.frame(index); }
    }
    static final Map<Integer, FrameRef> frames = new HashMap<>();
    static ThreadReference stoppedThread;
    static String exceptionText;
    static ObjectReference exceptionObject;

    static String norm(String p) { return p.replace('\\', '/').toLowerCase(); }

    // ---------------------------------------------------------------- main loop
    public static void main(String[] argv) throws Exception {
        proto = new PrintStream(new FileOutputStream(FileDescriptor.out), false);
        System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.err), true));
        InputStream in = new BufferedInputStream(System.in);
        for (;;) {
            int len = -1;
            for (;;) {
                String line = readLine(in);
                if (line == null) { shutdown(); return; }
                if (line.isEmpty()) break;
                if (line.toLowerCase().startsWith("content-length:")) len = Integer.parseInt(line.substring(15).trim());
            }
            if (len < 0) continue;
            byte[] buf = in.readNBytes(len);
            Map<String, Object> req = map(Json.parse(new String(buf, StandardCharsets.UTF_8)));
            try {
                handle(req);
            } catch (Throwable t) {
                respond(req, false, null, String.valueOf(t.getMessage() != null ? t.getMessage() : t));
            }
        }
    }

    static String readLine(InputStream in) throws IOException {
        StringBuilder b = new StringBuilder();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') return b.toString().replace("\r", "");
            b.append((char) c);
        }
        return b.length() == 0 ? null : b.toString();
    }

    static void handle(Map<String, Object> req) throws Exception {
        String cmd = str(req.get("command"));
        Map<String, Object> a = map(req.get("arguments"));
        switch (cmd) {
            case "initialize":
                respond(req, true, obj("supportsConfigurationDoneRequest", true, "supportsConditionalBreakpoints", true, "supportsEvaluateForHovers", true,
                    "supportsExceptionInfoRequest", true, "supportsTerminateRequest", true,
                    "exceptionBreakpointFilters", Arrays.asList(obj("filter", "uncaught", "label", "Uncaught Exceptions", "default", true), obj("filter", "all", "label", "All Exceptions", "default", false))), null);
                break;
            case "launch": launch(req, a); break;
            case "setBreakpoints": setBreakpoints(req, a); break;
            case "setExceptionBreakpoints": setExceptionBreakpoints(req, a); break;
            case "configurationDone": configurationDone(req); break;
            case "threads": threads(req); break;
            case "stackTrace": stackTrace(req, a); break;
            case "scopes": scopes(req, a); break;
            case "variables": variables(req, a); break;
            case "evaluate": evaluateRequest(req, a); break;
            case "exceptionInfo": exceptionInfo(req); break;
            case "continue": resume(); respond(req, true, obj("allThreadsContinued", true), null); break;
            case "next": step(req, StepRequest.STEP_OVER, a); break;
            case "stepIn": step(req, StepRequest.STEP_INTO, a); break;
            case "stepOut": step(req, StepRequest.STEP_OUT, a); break;
            case "pause":
                if (vm != null) { vm.suspend(); stoppedThread = firstThread(); invalidate(); event("stopped", obj("reason", "pause", "threadId", tid(stoppedThread), "allThreadsStopped", true)); }
                respond(req, true, null, null);
                break;
            case "disconnect": case "terminate":
                respond(req, true, null, null);
                shutdown();
                System.exit(0);
                break;
            default: respond(req, false, null, "Not supported: " + cmd);
        }
    }

    static void shutdown() {
        try { if (vm != null) { try { vm.exit(0); } catch (Exception e) { vm.dispose(); } } } catch (Exception ignored) { }
        if (proc != null && proc.isAlive()) proc.destroyForcibly();
    }

    // ---------------------------------------------------------------- launching
    static void launch(Map<String, Object> req, Map<String, Object> a) throws Exception {
        launchArgs = a;
        mainClass = str(a.get("mainClass"));
        stopOnEntry = Boolean.TRUE.equals(a.get("stopOnEntry"));
        for (Object r : list(a.get("sourceRoots"))) sourceRoots.add(String.valueOf(r));
        List<String> cmd = new ArrayList<>();
        cmd.add(str(a.get("javaExe")) == null ? "java" : str(a.get("javaExe")));
        cmd.add("-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0");
        cmd.add("-Dfile.encoding=UTF-8"); cmd.add("-Dstdout.encoding=UTF-8"); cmd.add("-Dstderr.encoding=UTF-8");
        for (Object v : list(a.get("vmArgs"))) cmd.add(String.valueOf(v));
        List<String> cp = new ArrayList<>();
        for (Object c : list(a.get("classpath"))) cp.add(String.valueOf(c));
        if (!cp.isEmpty()) { cmd.add("-cp"); cmd.add(String.join(File.pathSeparator, cp)); }
        cmd.add(mainClass);
        for (Object x : list(a.get("args"))) cmd.add(String.valueOf(x));
        ProcessBuilder pb = new ProcessBuilder(cmd);
        if (a.get("cwd") != null) pb.directory(new File(str(a.get("cwd"))));
        for (Map.Entry<String, Object> e : map(a.get("env")).entrySet()) pb.environment().put(e.getKey(), String.valueOf(e.getValue()));
        proc = pb.start();
        // The agent says on its output which port it listens on (one line); the rest of the output is the program's own.
        BufferedReader out = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8));
        BufferedReader err = new BufferedReader(new InputStreamReader(proc.getErrorStream(), StandardCharsets.UTF_8));
        String banner = out.readLine();
        java.util.regex.Matcher m = banner == null ? null : java.util.regex.Pattern.compile("address: (?:[^:]*:)?(\\d+)").matcher(banner);
        if (m == null || !m.find()) {
            StringBuilder why = new StringBuilder(banner == null ? "" : banner);
            if (!proc.isAlive() || banner == null) { try { String l; while (err.ready() && (l = err.readLine()) != null) why.append(' ').append(l); } catch (IOException ignored) { } }
            throw new IOException("The Java program did not start: " + why);
        }
        String port = m.group(1);
        pump(err, "stderr");
        pump(out, "stdout");
        AttachingConnector sock = null;
        for (AttachingConnector c : Bootstrap.virtualMachineManager().attachingConnectors()) if (c.name().equals("com.sun.jdi.SocketAttach")) sock = c;
        if (sock == null) throw new IOException("This JDK has no socket debugger connection.");
        Map<String, Connector.Argument> ca = sock.defaultArguments();
        ca.get("hostname").setValue("127.0.0.1");
        ca.get("port").setValue(port);
        vm = sock.attach(ca);
        vm.setDebugTraceMode(0);
        EventRequestManager erm = vm.eventRequestManager();
        // Classes loaded from now on may hold a breakpoint that was set before they existed.
        ClassPrepareRequest cpr = erm.createClassPrepareRequest();
        cpr.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        cpr.enable();
        new Thread(JavaDap::eventLoop, "events").start();
        pendingLaunch = req;
        event("initialized", obj());
    }

    static void pump(BufferedReader r, String category) {
        Thread t = new Thread(() -> {
            try {
                char[] buf = new char[4096]; int n;
                while ((n = r.read(buf)) >= 0) output(category, new String(buf, 0, n));
            } catch (IOException ignored) { }
        }, "pump-" + category);
        t.setDaemon(true);
        t.start();
    }

    static void configurationDone(Map<String, Object> req) {
        respond(req, true, null, null);
        if (pendingLaunch != null) {
            respond(pendingLaunch, true, null, null);
            pendingLaunch = null;
        }
        vm.resume();
    }

    // ---------------------------------------------------------------- breakpoints
    static void setBreakpoints(Map<String, Object> req, Map<String, Object> a) {
        String file = str(map(a.get("source")).get("path"));
        String key = norm(file);
        List<Bp> old = breakpoints.remove(key);
        if (old != null && vm != null) for (Bp b : old) for (BreakpointRequest r : b.reqs) { try { vm.eventRequestManager().deleteEventRequest(r); } catch (Exception ignored) { } }
        List<Bp> now = new ArrayList<>();
        List<Object> out = new ArrayList<>();
        for (Object o : list(a.get("breakpoints"))) {
            Map<String, Object> bm = map(o);
            Bp b = new Bp(); b.id = nextBp++; b.file = file; b.line = num(bm.get("line"), 1); b.condition = str(bm.get("condition"));
            now.add(b);
        }
        breakpoints.put(key, now);
        if (vm != null) {
            watchSource(file);
            for (ReferenceType t : new ArrayList<>(vm.allClasses())) for (Bp b : now) tryResolve(b, t);
        }
        for (Bp b : now) out.add(obj("id", b.id, "verified", b.verified, "line", b.line));
        respond(req, true, obj("breakpoints", out), null);
    }

    // A class whose source file has this name gets its breakpoints when it is loaded.
    static void watchSource(String file) {
        String name = new File(file).getName();
        if (!watchedSources.add(name)) return;
        // (class prepare events for every class are already requested; they are filtered by source name below)
    }

    static boolean sameSource(ReferenceType t, String file) {
        try {
            for (String sp : t.sourcePaths(vm.getDefaultStratum())) {
                String rel = norm(sp);
                if (norm(file).endsWith("/" + rel) || norm(file).equals(rel)) return true;
            }
        } catch (AbsentInformationException e) { /* no debug information */ }
        return false;
    }

    static void tryResolve(Bp b, ReferenceType t) {
        if (!t.isPrepared() || !sameSource(t, b.file)) return;
        try {
            List<Location> locs = t.locationsOfLine(b.line);
            if (locs.isEmpty()) {
                // A line without code: the next line that has some.
                int best = Integer.MAX_VALUE;
                for (Location l : t.allLineLocations()) if (l.lineNumber() >= b.line && l.lineNumber() < best) best = l.lineNumber();
                if (best == Integer.MAX_VALUE) return;
                locs = t.locationsOfLine(best);
            }
            if (locs.isEmpty()) return;
            for (Location l : locs.subList(0, 1)) {
                BreakpointRequest r = vm.eventRequestManager().createBreakpointRequest(l);
                r.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                r.putProperty("bp", b);
                r.enable();
                b.reqs.add(r);
            }
            boolean was = b.verified;
            b.verified = true;
            if (!was) event("breakpoint", obj("reason", "changed", "breakpoint", obj("id", b.id, "verified", true, "line", locs.get(0).lineNumber())));
        } catch (AbsentInformationException | ObjectCollectedException e) { /* nothing to do */ }
    }

    static void setExceptionBreakpoints(Map<String, Object> req, Map<String, Object> a) {
        if (vm != null) {
            EventRequestManager erm = vm.eventRequestManager();
            if (exceptionRequest != null) { erm.deleteEventRequest(exceptionRequest); exceptionRequest = null; }
            List<Object> filters = list(a.get("filters"));
            boolean all = filters.contains("all"), uncaught = filters.contains("uncaught") || all;
            if (all || uncaught) {
                exceptionRequest = erm.createExceptionRequest(null, all, true);
                exceptionRequest.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                exceptionRequest.enable();
            }
        }
        respond(req, true, obj("breakpoints", new ArrayList<>()), null);
    }

    // ---------------------------------------------------------------- events
    static void eventLoop() {
        EventQueue q = vm.eventQueue();
        try {
            for (;;) {
                EventSet set = q.remove();
                boolean stop = false, started = false;
                String reason = null;
                ThreadReference thread = null;
                for (Event e : set) {
                    if (e instanceof VMStartEvent) {
                        started = true; // the program stays stopped until the editor has sent its breakpoints (configurationDone)
                    } else if (e instanceof ClassPrepareEvent) {
                        ReferenceType t = ((ClassPrepareEvent) e).referenceType();
                        for (List<Bp> l : breakpoints.values()) for (Bp b : l) tryResolve(b, t);
                        if (stopOnEntry && t.name().equals(mainClass)) {
                            try {
                                for (Method m : t.methodsByName("main")) {
                                    if (m.isStatic() && !m.isAbstract() && !m.locationsOfLine(m.location().lineNumber()).isEmpty()) {
                                        BreakpointRequest r = vm.eventRequestManager().createBreakpointRequest(m.location());
                                        r.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                                        r.putProperty("entry", Boolean.TRUE);
                                        r.enable();
                                    }
                                }
                            } catch (Exception ignored) { }
                        }
                    } else if (e instanceof BreakpointEvent) {
                        BreakpointEvent be = (BreakpointEvent) e;
                        Bp b = (Bp) be.request().getProperty("bp");
                        thread = be.thread();
                        if (b != null && b.condition != null && !b.condition.trim().isEmpty()) {
                            try {
                                Object v = evalIn(thread, b.condition);
                                if (Boolean.FALSE.equals(v)) continue;
                            } catch (Exception ex) { output("console", "Breakpoint condition failed: " + ex.getMessage() + "\n"); }
                        }
                        stop = true;
                        reason = be.request().getProperty("entry") != null ? "entry" : "breakpoint";
                    } else if (e instanceof StepEvent) {
                        thread = ((StepEvent) e).thread();
                        vm.eventRequestManager().deleteEventRequest(e.request());
                        stop = true; reason = "step";
                    } else if (e instanceof ExceptionEvent) {
                        ExceptionEvent ee = (ExceptionEvent) e;
                        thread = ee.thread(); exceptionObject = ee.exception();
                        exceptionText = ee.exception().referenceType().name();
                        stop = true; reason = "exception";
                    } else if (e instanceof VMDeathEvent || e instanceof VMDisconnectEvent) {
                        finish();
                        return;
                    }
                }
                if (stop) {
                    stoppedThread = thread;
                    invalidate();
                    Map<String, Object> body = obj("reason", reason, "threadId", tid(thread), "allThreadsStopped", true);
                    if ("exception".equals(reason)) body.put("text", exceptionText);
                    event("stopped", body);
                } else if (!started) {
                    set.resume();
                }
            }
        } catch (VMDisconnectedException e) {
            finish();
        } catch (InterruptedException ignored) { }
    }

    static void finish() {
        synchronized (lock) {
            if (terminated) return;
            terminated = true;
        }
        int code = 0;
        try { if (proc != null) code = proc.waitFor(); } catch (InterruptedException ignored) { }
        try { Thread.sleep(150); } catch (InterruptedException ignored) { }
        event("exited", obj("exitCode", code));
        event("terminated", obj());
    }

    static void invalidate() { frames.clear(); handles.clear(); nextHandle = 1; }

    static void resume() {
        for (EventRequest r : new ArrayList<>(vm.eventRequestManager().stepRequests())) { if (!r.isEnabled()) vm.eventRequestManager().deleteEventRequest(r); }
        invalidate();
        vm.resume();
    }

    static void step(Map<String, Object> req, int depth, Map<String, Object> a) {
        ThreadReference t = threadById(num(a.get("threadId"), -1));
        EventRequestManager erm = vm.eventRequestManager();
        for (StepRequest old : new ArrayList<>(erm.stepRequests())) erm.deleteEventRequest(old);
        StepRequest sr = erm.createStepRequest(t, StepRequest.STEP_LINE, depth);
        sr.addCountFilter(1);
        sr.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        if (depth == StepRequest.STEP_INTO) for (String ex : new String[] {"java.*", "javax.*", "sun.*", "jdk.*", "com.sun.*"}) sr.addClassExclusionFilter(ex);
        sr.enable();
        respond(req, true, null, null);
        invalidate();
        vm.resume();
    }

    // ---------------------------------------------------------------- threads, frames, variables
    static int tid(ThreadReference t) { return t == null ? 0 : (int) t.uniqueID(); }
    static ThreadReference threadById(int id) {
        for (ThreadReference t : vm.allThreads()) if (tid(t) == id) return t;
        return stoppedThread;
    }
    static ThreadReference firstThread() {
        for (ThreadReference t : vm.allThreads()) if (t.name().equals("main")) return t;
        return vm.allThreads().isEmpty() ? null : vm.allThreads().get(0);
    }

    static void threads(Map<String, Object> req) {
        List<Object> out = new ArrayList<>();
        if (vm != null) for (ThreadReference t : vm.allThreads()) out.add(obj("id", tid(t), "name", t.name()));
        respond(req, true, obj("threads", out), null);
    }

    static String sourceFile(Location l) {
        try {
            String rel = l.sourcePath();
            for (String root : sourceRoots) { File f = new File(root, rel); if (f.exists()) return f.getPath(); }
            String cwd = str(launchArgs.get("cwd"));
            if (cwd != null) { File f = new File(cwd, l.sourceName()); if (f.exists()) return f.getPath(); }
        } catch (AbsentInformationException ignored) { }
        return null;
    }

    static void stackTrace(Map<String, Object> req, Map<String, Object> a) throws Exception {
        ThreadReference t = threadById(num(a.get("threadId"), -1));
        List<Object> out = new ArrayList<>();
        int start = num(a.get("startFrame"), 0), levels = num(a.get("levels"), 50);
        List<StackFrame> fs = t.frames();
        for (int k = start; k < fs.size() && k < start + levels; k++) {
            StackFrame f = fs.get(k);
            Location l = f.location();
            int id = 100000 + frames.size() + 1;
            frames.put(id, new FrameRef(t, k));
            String file = sourceFile(l);
            Map<String, Object> fm = obj("id", id, "name", l.declaringType().name() + "." + l.method().name() + "()", "line", Math.max(l.lineNumber(), 0), "column", 1);
            if (file != null) fm.put("source", obj("name", new File(file).getName(), "path", file));
            out.add(fm);
        }
        respond(req, true, obj("stackFrames", out, "totalFrames", fs.size()), null);
    }

    static void scopes(Map<String, Object> req, Map<String, Object> a) {
        FrameRef f = frames.get(num(a.get("frameId"), -1));
        List<Object> out = new ArrayList<>();
        if (f != null) out.add(obj("name", "Locals", "variablesReference", handle(f), "expensive", false));
        respond(req, true, obj("scopes", out), null);
    }

    static final class ArrayPart { ArrayReference arr; ArrayPart(ArrayReference a) { arr = a; } }

    static void variables(Map<String, Object> req, Map<String, Object> a) throws Exception {
        Object h = handles.get(num(a.get("variablesReference"), -1));
        List<Object> out = new ArrayList<>();
        if (h instanceof FrameRef) {
            FrameRef fr = (FrameRef) h;
            // The values are read first; showing them may call toString() in the program, which ends the life of the frame object.
            List<String> names = new ArrayList<>();
            List<Value> values = new ArrayList<>();
            StackFrame f = fr.get();
            ObjectReference self = null;
            try { self = f.thisObject(); } catch (Exception ignored) { }
            if (self != null) { names.add("this"); values.add(self); }
            try {
                for (LocalVariable lv : f.visibleVariables()) { names.add(lv.name()); values.add(f.getValue(lv)); }
            } catch (AbsentInformationException e) { out.add(obj("name", "(no debug information)", "value", "compile with -g", "variablesReference", 0)); }
            for (int k = 0; k < names.size(); k++) out.add(variable(names.get(k), values.get(k), fr.thread));
        } else if (h instanceof ArrayPart) {
            ArrayReference arr = ((ArrayPart) h).arr;
            int n = arr.length(), start = num(a.get("start"), 0), count = a.get("count") == null ? Math.min(n, 100) : num(a.get("count"), 100);
            for (int k = start; k < n && k < start + count; k++) out.add(variable("[" + k + "]", arr.getValue(k), stoppedThread));
        } else if (h instanceof ObjectReference) {
            ObjectReference o = (ObjectReference) h;
            Map<Field, Value> vals = o.getValues(o.referenceType().visibleFields());
            for (Map.Entry<Field, Value> e : vals.entrySet()) if (!e.getKey().isStatic() || true) out.add(variable(e.getKey().name(), e.getValue(), stoppedThread));
            out.sort(Comparator.comparing(x -> String.valueOf(map(x).get("name"))));
        }
        respond(req, true, obj("variables", out), null);
    }

    static Map<String, Object> variable(String name, Value v, ThreadReference t) {
        Map<String, Object> m = obj("name", name, "value", show(v, t), "type", v == null ? "null" : v.type().name(), "variablesReference", 0);
        if (v instanceof ArrayReference && ((ArrayReference) v).length() > 0) m.put("variablesReference", handle(new ArrayPart((ArrayReference) v)));
        else if (v instanceof ObjectReference && !(v instanceof StringReference) && !(v instanceof ArrayReference) && !isBoxed(v) && !((ObjectReference) v).referenceType().visibleFields().isEmpty()) m.put("variablesReference", handle(v));
        return m;
    }

    static boolean isBoxed(Value v) {
        if (!(v instanceof ObjectReference)) return false;
        String n = ((ObjectReference) v).referenceType().name();
        return n.startsWith("java.lang.") && (n.equals("java.lang.Integer") || n.equals("java.lang.Long") || n.equals("java.lang.Double") || n.equals("java.lang.Float") || n.equals("java.lang.Short") || n.equals("java.lang.Byte") || n.equals("java.lang.Boolean") || n.equals("java.lang.Character"));
    }

    static String show(Value v, ThreadReference t) {
        if (v == null) return "null";
        if (v instanceof StringReference) { String s = ((StringReference) v).value(); return "\"" + (s.length() > 300 ? s.substring(0, 300) + "..." : s) + "\""; }
        if (v instanceof CharValue) return "'" + ((CharValue) v).value() + "'";
        if (v instanceof PrimitiveValue) return v.toString();
        if (v instanceof ArrayReference) return ((ArrayReference) v).referenceType().name().replace("[]", "[" + ((ArrayReference) v).length() + "]");
        if (v instanceof ObjectReference) {
            ObjectReference o = (ObjectReference) v;
            String cn = o.referenceType().name();
            // Library objects tell what they are with toString(); the program's own objects are shown as Type@id.
            if (t != null && (cn.startsWith("java.") || isEnum(o))) {
                try {
                    Method ts = null;
                    for (Method m : o.referenceType().methodsByName("toString")) if (m.argumentTypes().isEmpty()) ts = m;
                    if (ts != null) {
                        Value r = o.invokeMethod(t, ts, new ArrayList<>(), ObjectReference.INVOKE_SINGLE_THREADED);
                        if (r instanceof StringReference) { String s = ((StringReference) r).value(); return s.length() > 300 ? s.substring(0, 300) + "..." : s; }
                    }
                } catch (Exception ignored) { }
            }
            return cn.substring(cn.lastIndexOf('.') + 1) + "@" + o.uniqueID();
        }
        return String.valueOf(v);
    }

    static boolean isEnum(ObjectReference o) {
        ClassType c = o.referenceType() instanceof ClassType ? (ClassType) o.referenceType() : null;
        return c != null && c.superclass() != null && c.superclass().name().equals("java.lang.Enum");
    }

    static void exceptionInfo(Map<String, Object> req) {
        String msg = null;
        try {
            if (exceptionObject != null && stoppedThread != null) {
                Method gm = exceptionObject.referenceType().methodsByName("getMessage").get(0);
                Value r = exceptionObject.invokeMethod(stoppedThread, gm, new ArrayList<>(), ObjectReference.INVOKE_SINGLE_THREADED);
                if (r instanceof StringReference) msg = ((StringReference) r).value();
            }
        } catch (Exception ignored) { }
        respond(req, true, obj("exceptionId", exceptionText == null ? "Exception" : exceptionText, "description", msg == null ? "" : msg, "breakMode", "unhandled"), null);
    }

    // ---------------------------------------------------------------- expressions
    static void evaluateRequest(Map<String, Object> req, Map<String, Object> a) {
        String expr = str(a.get("expression"));
        FrameRef f = a.get("frameId") == null ? null : frames.get(num(a.get("frameId"), -1));
        ThreadReference t = f != null ? f.thread : stoppedThread;
        try {
            if (t == null) throw new IllegalStateException("The program is not stopped.");
            Object r = new Eval(f != null ? f : new FrameRef(t, 0), t, expr).run();
            Value v = toValue(r);
            Map<String, Object> body = obj("result", show(v, t), "type", v == null ? "null" : v.type().name(), "variablesReference", 0);
            Map<String, Object> vv = variable("", v, t);
            body.put("variablesReference", vv.get("variablesReference"));
            respond(req, true, body, null);
        } catch (Exception e) {
            respond(req, false, null, e.getMessage() == null ? e.toString() : e.getMessage());
        }
    }

    static Object evalIn(ThreadReference t, String expr) throws Exception {
        return new Eval(new FrameRef(t, 0), t, expr).run();
    }

    static Value toValue(Object o) {
        if (o == null) return null;
        if (o instanceof Value) return (Value) o;
        if (o instanceof Integer) return vm.mirrorOf((Integer) o);
        if (o instanceof Long) return vm.mirrorOf((Long) o);
        if (o instanceof Double) return vm.mirrorOf((Double) o);
        if (o instanceof Boolean) return vm.mirrorOf((Boolean) o);
        if (o instanceof Character) return vm.mirrorOf((Character) o);
        return vm.mirrorOf(String.valueOf(o));
    }

    // Java expressions: literals, names, fields, array elements, method calls, arithmetic, comparison, && || !, string +.
    static final class Eval {
        final FrameRef ref; final ThreadReference thread; final String s; int p = 0;
        Eval(FrameRef f, ThreadReference t, String s) { ref = f; thread = t; this.s = s; }
        StackFrame fr() throws IncompatibleThreadStateException { return ref.get(); }

        Object run() throws Exception {
            Object v = or();
            ws();
            if (p < s.length()) throw new IllegalArgumentException("Unexpected '" + s.charAt(p) + "'");
            return plain(v);
        }
        void ws() { while (p < s.length() && Character.isWhitespace(s.charAt(p))) p++; }
        boolean eat(String t) { ws(); if (s.startsWith(t, p)) { p += t.length(); return true; } return false; }
        boolean peekIs(String t) { ws(); return s.startsWith(t, p); }

        // JDI values become Java values for arithmetic; objects stay as references.
        Object plain(Object v) {
            if (v instanceof StringReference) return ((StringReference) v).value();
            if (v instanceof IntegerValue) return ((IntegerValue) v).value();
            if (v instanceof LongValue) return ((LongValue) v).value();
            if (v instanceof ShortValue) return (int) ((ShortValue) v).value();
            if (v instanceof ByteValue) return (int) ((ByteValue) v).value();
            if (v instanceof FloatValue) return (double) ((FloatValue) v).value();
            if (v instanceof DoubleValue) return ((DoubleValue) v).value();
            if (v instanceof BooleanValue) return ((BooleanValue) v).value();
            if (v instanceof CharValue) return ((CharValue) v).value();
            return v;
        }
        static boolean isNum(Object o) { return o instanceof Integer || o instanceof Long || o instanceof Double || o instanceof Character; }
        static double d(Object o) { return o instanceof Character ? (double) (Character) o : ((Number) o).doubleValue(); }
        static long l(Object o) { return o instanceof Character ? (long) (Character) o : ((Number) o).longValue(); }

        Object or() throws Exception { Object v = and(); while (eat("||")) { Object r = and(); v = (Boolean) v || (Boolean) r; } return v; }
        Object and() throws Exception { Object v = eq(); while (eat("&&")) { Object r = eq(); v = (Boolean) v && (Boolean) r; } return v; }
        Object eq() throws Exception {
            Object v = rel();
            for (;;) {
                if (eat("==")) { Object r = rel(); v = same(v, r); }
                else if (eat("!=")) { Object r = rel(); v = !same(v, r); }
                else return v;
            }
        }
        boolean same(Object a, Object b) {
            if (isNum(a) && isNum(b)) return d(a) == d(b);
            if (a instanceof ObjectReference && b instanceof ObjectReference) return a.equals(b);
            return Objects.equals(a, b);
        }
        Object rel() throws Exception {
            Object v = add();
            for (;;) {
                if (eat("<=")) { Object r = add(); v = d(v) <= d(r); }
                else if (eat(">=")) { Object r = add(); v = d(v) >= d(r); }
                else if (peekIs("<") && !peekIs("<<")) { p++; Object r = add(); v = d(v) < d(r); }
                else if (peekIs(">") && !peekIs(">>")) { p++; Object r = add(); v = d(v) > d(r); }
                else return v;
            }
        }
        Object add() throws Exception {
            Object v = mul();
            for (;;) {
                ws();
                if (p < s.length() && s.charAt(p) == '+') {
                    p++; Object r = mul();
                    if (v instanceof String || r instanceof String) v = text(v) + text(r);
                    else if (v instanceof Double || r instanceof Double) v = d(v) + d(r);
                    else if (v instanceof Long || r instanceof Long) v = l(v) + l(r);
                    else v = (int) (l(v) + l(r));
                } else if (p < s.length() && s.charAt(p) == '-') {
                    p++; Object r = mul();
                    if (v instanceof Double || r instanceof Double) v = d(v) - d(r);
                    else if (v instanceof Long || r instanceof Long) v = l(v) - l(r);
                    else v = (int) (l(v) - l(r));
                } else return v;
            }
        }
        String text(Object o) { return o instanceof Value ? show((Value) o, thread) : String.valueOf(o); }
        Object mul() throws Exception {
            Object v = unary();
            for (;;) {
                ws();
                char c = p < s.length() ? s.charAt(p) : 0;
                if (c != '*' && c != '/' && c != '%') return v;
                p++; Object r = unary();
                boolean dbl = v instanceof Double || r instanceof Double, lng = v instanceof Long || r instanceof Long;
                if (c == '*') v = dbl ? (Object) (d(v) * d(r)) : lng ? (Object) (l(v) * l(r)) : (Object) (int) (l(v) * l(r));
                else if (c == '/') { if (!dbl && l(r) == 0) throw new ArithmeticException("/ by zero"); v = dbl ? (Object) (d(v) / d(r)) : lng ? (Object) (l(v) / l(r)) : (Object) (int) (l(v) / l(r)); }
                else v = dbl ? (Object) (d(v) % d(r)) : lng ? (Object) (l(v) % l(r)) : (Object) (int) (l(v) % l(r));
            }
        }
        Object unary() throws Exception {
            ws();
            if (eat("!")) return !(Boolean) unary();
            if (p < s.length() && s.charAt(p) == '-') { p++; Object v = unary(); return v instanceof Double ? (Object) (-d(v)) : v instanceof Long ? (Object) (-l(v)) : (Object) (int) (-l(v)); }
            return postfix();
        }
        Object postfix() throws Exception {
            Object v = primary();
            for (;;) {
                ws();
                if (p < s.length() && s.charAt(p) == '.') {
                    p++; ws();
                    String name = ident();
                    ws();
                    if (p < s.length() && s.charAt(p) == '(') { v = call(v, name); }
                    else v = field(v, name);
                } else if (p < s.length() && s.charAt(p) == '[') {
                    p++; Object idx = or(); ws();
                    if (p >= s.length() || s.charAt(p++) != ']') throw new IllegalArgumentException("Missing ]");
                    if (!(v instanceof ArrayReference)) throw new IllegalArgumentException("Not an array");
                    v = plain(((ArrayReference) v).getValue((int) l(idx)));
                } else return v;
            }
        }
        String ident() {
            int st = p;
            while (p < s.length() && (Character.isJavaIdentifierPart(s.charAt(p)))) p++;
            if (st == p) throw new IllegalArgumentException("A name was expected");
            return s.substring(st, p);
        }
        Object primary() throws Exception {
            ws();
            if (p >= s.length()) throw new IllegalArgumentException("The expression ends too soon");
            char c = s.charAt(p);
            if (c == '(') { p++; Object v = or(); ws(); if (p >= s.length() || s.charAt(p++) != ')') throw new IllegalArgumentException("Missing )"); return v; }
            if (c == '"') {
                StringBuilder b = new StringBuilder(); p++;
                while (p < s.length() && s.charAt(p) != '"') { char x = s.charAt(p++); if (x == '\\' && p < s.length()) { char e = s.charAt(p++); b.append(e == 'n' ? '\n' : e == 't' ? '\t' : e); } else b.append(x); }
                p++;
                return b.toString();
            }
            if (c == '\'') { char x = s.charAt(p + 1); p += 3; return x; }
            if (Character.isDigit(c)) {
                int st = p;
                while (p < s.length() && (Character.isDigit(s.charAt(p)) || s.charAt(p) == '.')) p++;
                String n = s.substring(st, p);
                if (p < s.length() && (s.charAt(p) == 'L' || s.charAt(p) == 'l')) { p++; return Long.parseLong(n); }
                if (n.contains(".")) return Double.parseDouble(n);
                long x = Long.parseLong(n);
                return x > Integer.MAX_VALUE ? (Object) x : (Object) (int) x;
            }
            String name = ident();
            if (name.equals("true")) return true;
            if (name.equals("false")) return false;
            if (name.equals("null")) return null;
            if (name.equals("this")) return fr().thisObject();
            ws();
            if (p < s.length() && s.charAt(p) == '(') { ObjectReference self = fr().thisObject(); if (self == null) throw new IllegalArgumentException("No object to call " + name + " on"); return call(self, name); }
            try {
                LocalVariable lv = fr().visibleVariableByName(name);
                if (lv != null) return plain(fr().getValue(lv));
            } catch (AbsentInformationException ignored) { }
            ObjectReference self = fr().thisObject();
            if (self != null) { Field f = self.referenceType().fieldByName(name); if (f != null) return plain(self.getValue(f)); }
            ReferenceType decl = fr().location().declaringType();
            Field sf = decl.fieldByName(name);
            if (sf != null && sf.isStatic()) return plain(decl.getValue(sf));
            // A class name: java.lang ones by their short name, others by their full name
            StringBuilder qn = new StringBuilder(name);
            for (;;) {
                List<ReferenceType> found = vm.classesByName(qn.toString());
                if (found.isEmpty()) found = vm.classesByName("java.lang." + qn);
                if (!found.isEmpty()) return found.get(0);
                if (p < s.length() && s.charAt(p) == '.') {
                    int save = p; p++;
                    if (p < s.length() && Character.isJavaIdentifierStart(s.charAt(p))) { qn.append('.').append(ident()); continue; }
                    p = save;
                }
                break;
            }
            throw new IllegalArgumentException("'" + name + "' is not defined here");
        }
        Object field(Object target, String name) throws Exception {
            if (target instanceof ArrayReference && name.equals("length")) return ((ArrayReference) target).length();
            if (target instanceof ObjectReference) {
                Field f = ((ObjectReference) target).referenceType().fieldByName(name);
                if (f == null) throw new IllegalArgumentException("No field " + name);
                return plain(f.isStatic() ? ((ObjectReference) target).referenceType().getValue(f) : ((ObjectReference) target).getValue(f));
            }
            if (target instanceof ReferenceType) {
                Field f = ((ReferenceType) target).fieldByName(name);
                if (f != null && f.isStatic()) return plain(((ReferenceType) target).getValue(f));
                for (ReferenceType n : ((ReferenceType) target).nestedTypes()) if (n.name().endsWith("$" + name)) return n;
                throw new IllegalArgumentException("No static field " + name);
            }
            throw new IllegalArgumentException("Cannot read ." + name);
        }
        Object call(Object target, String name) throws Exception {
            p++; // (
            List<Object> args = new ArrayList<>();
            ws();
            if (p < s.length() && s.charAt(p) == ')') p++;
            else for (;;) { args.add(or()); ws(); if (p < s.length() && s.charAt(p) == ',') { p++; continue; } if (p < s.length() && s.charAt(p) == ')') { p++; break; } throw new IllegalArgumentException("Missing )"); }
            List<Value> vals = new ArrayList<>();
            for (Object a : args) vals.add(toValue(a));
            ReferenceType type = target instanceof ReferenceType ? (ReferenceType) target : target instanceof ObjectReference ? ((ObjectReference) target).referenceType() : null;
            if (type == null) { if (target instanceof String) { type = vm.classesByName("java.lang.String").get(0); target = vm.mirrorOf((String) target); } else throw new IllegalArgumentException("Cannot call " + name); }
            Method found = null;
            for (Method m : type.methodsByName(name)) {
                if (m.argumentTypeNames().size() != vals.size()) continue;
                found = m;
                boolean exact = true;
                try {
                    for (int k = 0; k < vals.size(); k++) { Value v = vals.get(k); Type at = m.argumentTypes().get(k); if (v != null && at instanceof PrimitiveType != v instanceof PrimitiveValue) exact = false; }
                } catch (ClassNotLoadedException e) { exact = false; }
                if (exact) break;
            }
            if (found == null) throw new IllegalArgumentException("No method " + name + " with " + vals.size() + " argument(s)");
            Value r;
            if (target instanceof ObjectReference) r = ((ObjectReference) target).invokeMethod(thread, found, vals, ObjectReference.INVOKE_SINGLE_THREADED);
            else if (type instanceof ClassType) r = ((ClassType) type).invokeMethod(thread, found, vals, ObjectReference.INVOKE_SINGLE_THREADED);
            else throw new IllegalArgumentException("Cannot call " + name);
            return plain(r);
        }
    }
}
