package com.wallpaint.tv;

import android.content.Context;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * Small HTTP + WebSocket server that runs on the TV box itself.
 * Serves the phone page (/) and the TV page (/tv) from assets and relays strokes.
 */
public class WallServer {
    private static final Charset UTF8 = Charset.forName("UTF-8");

    private final Context ctx;
    private final int port;
    private ServerSocket server;
    private volatile boolean running;
    private final CopyOnWriteArrayList<Client> clients = new CopyOnWriteArrayList<Client>();

    // drawing state, guarded by `lock`
    private final Object lock = new Object();
    // display list: stroke / shape / fill / text / image objects, in drawing order
    private final ArrayList<JSONObject> objs = new ArrayList<JSONObject>();
    private double aspect = 16.0 / 9.0;
    // pen: only the holder may draw; others may ask for it
    private static final long ASK_TIMEOUT_MS = 10000;
    private Client holder;
    private Client asker;
    private long askDeadline;
    private int nextId = 1;

    class Client {
        final Socket socket;
        final OutputStream out;
        final LinkedBlockingQueue<byte[]> queue = new LinkedBlockingQueue<byte[]>();
        volatile boolean alive = true;
        String role = "";
        int id;
        String name = "";
        Client(Socket s) throws IOException { socket = s; out = s.getOutputStream(); }
        void send(byte[] frame) { if (alive) queue.offer(frame); }
        void send(String json) { send(textFrame(json)); }
        void close() {
            synchronized (this) {
                if (!alive) return;
                alive = false;
            }
            clients.remove(this);
            queue.offer(new byte[0]);
            try { socket.close(); } catch (IOException ignored) { }
            onLeave(this);
        }
    }

    public WallServer(Context ctx, int port) { this.ctx = ctx.getApplicationContext(); this.port = port; }

    /** Binds the port (call off the main thread). */
    public void start() throws IOException {
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(port));
        running = true;
        new Thread(new Runnable() { @Override public void run() { acceptLoop(); } }, "wp-accept").start();
        new Thread(new Runnable() { @Override public void run() { pingLoop(); } }, "wp-ping").start();
    }

    public void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        for (Client c : clients) c.close();
    }

    public String phoneUrl() {
        String ip = lanIp();
        return "http://" + (ip != null ? ip : "?.?.?.?") + (port == 80 ? "" : ":" + port) + "/";
    }

    public static String lanIp() {
        String fallback = null;
        try {
            List<NetworkInterface> list = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface ni : list) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
                    String n = ni.getName();
                    if (n.startsWith("wlan") || n.startsWith("eth")) return a.getHostAddress();
                    if (fallback == null) fallback = a.getHostAddress();
                }
            }
        } catch (Exception ignored) { }
        return fallback;
    }

    // ---------------------------------------------------------------- network loops

    private void acceptLoop() {
        while (running) {
            try {
                final Socket s = server.accept();
                s.setTcpNoDelay(true);
                new Thread(new Runnable() { @Override public void run() { handle(s); } }, "wp-conn").start();
            } catch (IOException e) {
                if (!running) return;
            }
        }
    }

    private void pingLoop() {
        byte[] ping = new byte[] { (byte) 0x89, 0 };
        int ticks = 0;
        while (running) {
            try { Thread.sleep(500); } catch (InterruptedException e) { return; }
            if (++ticks % 40 == 0) for (Client c : clients) c.send(ping);
            synchronized (lock) {
                if (asker != null && System.currentTimeMillis() > askDeadline) {
                    // holder did not answer in time: hand the pen over
                    if (asker.alive) holder = asker;
                    asker = null;
                    broadcastPen();
                }
            }
        }
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(0);
            InputStream in = s.getInputStream();
            String requestLine = readLine(in);
            if (requestLine == null) { s.close(); return; }
            String key = null, upgrade = null, line;
            while ((line = readLine(in)) != null && line.length() > 0) {
                int i = line.indexOf(':');
                if (i <= 0) continue;
                String h = line.substring(0, i).trim().toLowerCase(Locale.US), v = line.substring(i + 1).trim();
                if (h.equals("sec-websocket-key")) key = v;
                else if (h.equals("upgrade")) upgrade = v;
            }
            String[] parts = requestLine.split(" ");
            String path = parts.length > 1 ? parts[1] : "/";
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);

            if (path.equals("/ws") && key != null && "websocket".equalsIgnoreCase(upgrade)) {
                webSocket(s, in, key);
            } else {
                serveFile(s, path);
            }
        } catch (Exception e) {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    private void serveFile(Socket s, String path) throws IOException {
        if (path.equals("/") || path.equals("/index.html")) path = "/phone.html";
        else if (path.equals("/tv") || path.equals("/tv/")) path = "/tv.html";
        String name = path.substring(1);
        OutputStream out = s.getOutputStream();
        byte[] body;
        String type = "application/octet-stream";
        if (name.endsWith(".html")) type = "text/html; charset=utf-8";
        else if (name.endsWith(".js")) type = "application/javascript; charset=utf-8";
        else if (name.endsWith(".png")) type = "image/png";
        try {
            if (name.contains("..") || name.contains("/")) throw new IOException("bad path");
            body = readAll(ctx.getAssets().open(name));
        } catch (IOException e) {
            byte[] msg = "not found".getBytes(UTF8);
            out.write(("HTTP/1.1 404 Not Found\r\nContent-Length: " + msg.length + "\r\nConnection: close\r\n\r\n").getBytes(UTF8));
            out.write(msg); out.flush(); s.close();
            return;
        }
        out.write(("HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").getBytes(UTF8));
        out.write(body);
        out.flush();
        s.close();
    }

    private void webSocket(Socket s, InputStream rawIn, String key) throws Exception {
        MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
        String accept = Base64.encodeToString(
                sha1.digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(UTF8)), Base64.NO_WRAP);
        final Client c = new Client(s);
        s.setSoTimeout(60000); // phone pongs our pings every 20 s; silence for 60 s means it is gone
        c.out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(UTF8));
        c.out.flush();
        clients.add(c);

        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    while (c.alive) {
                        byte[] b = c.queue.take();
                        if (b.length == 0) break;
                        c.out.write(b);
                        if (c.queue.isEmpty()) c.out.flush();
                    }
                } catch (Exception ignored) { }
                c.close();
            }
        }, "wp-write").start();

        DataInputStream in = new DataInputStream(rawIn);
        ByteArrayOutputStream fragments = new ByteArrayOutputStream();
        try {
            while (c.alive) {
                int b0 = in.readUnsignedByte(), b1 = in.readUnsignedByte();
                boolean fin = (b0 & 0x80) != 0;
                int op = b0 & 0x0f;
                long len = b1 & 0x7f;
                if (len == 126) len = in.readUnsignedShort();
                else if (len == 127) len = in.readLong();
                if (len > 16 * 1024 * 1024) break;
                byte[] mask = null;
                if ((b1 & 0x80) != 0) { mask = new byte[4]; in.readFully(mask); }
                byte[] data = new byte[(int) len];
                in.readFully(data);
                if (mask != null) for (int i = 0; i < data.length; i++) data[i] ^= mask[i & 3];

                if (op == 0x8) break;                       // close
                if (op == 0x9) { c.send(frame(0x8a, data)); continue; } // ping -> pong
                if (op == 0xa) continue;                    // pong
                if (op == 0x1 || op == 0x0) {
                    fragments.write(data);
                    if (!fin) continue;
                    String text = new String(fragments.toByteArray(), UTF8);
                    fragments.reset();
                    try { onMessage(c, text); } catch (Exception ignored) { }
                }
            }
        } catch (IOException ignored) {
        } finally {
            c.close();
        }
    }

    // ---------------------------------------------------------------- protocol

    private void onMessage(Client c, String text) throws Exception {
        JSONObject m = new JSONObject(text);
        String t = m.optString("t");
        synchronized (lock) {
            if (t.equals("hello")) {
                boolean first = c.role.length() == 0;
                c.role = "tv".equals(m.optString("role")) ? "tv" : "phone";
                double w = m.optDouble("w", 0), h = m.optDouble("h", 0);
                if (c.role.equals("tv") && w > 0 && h > 0) {
                    aspect = w / h;
                    broadcast("{\"t\":\"aspect\",\"a\":" + aspect + "}", c);
                }
                if (c.role.equals("phone")) {
                    if (first) c.id = nextId++;
                    c.name = cleanName(m.optString("name", ""), c);
                    c.send("{\"t\":\"you\",\"id\":" + c.id + "}");
                    if (holder == null || !holder.alive) holder = c;
                }
                c.send(stateJson());
                broadcastPen();
                return;
            }
            if (t.equals("hint")) { // any phone may show the QR code on the wall
                broadcast("{\"t\":\"hint\"}", c);
                return;
            }
            if (t.equals("name")) {
                c.name = cleanName(m.optString("name", ""), c);
                broadcastPen();
                return;
            }
            if (t.equals("ask")) {
                if (!c.role.equals("phone") || c == holder) return;
                if (holder == null || !holder.alive) { holder = c; asker = null; broadcastPen(); return; }
                asker = c;
                askDeadline = System.currentTimeMillis() + ASK_TIMEOUT_MS;
                holder.send("{\"t\":\"ask\",\"from\":" + c.id + ",\"name\":" + JSONObject.quote(c.name)
                        + ",\"sec\":" + (ASK_TIMEOUT_MS / 1000) + "}");
                c.send("{\"t\":\"asked\"}");
                return;
            }
            if (t.equals("give") || t.equals("deny")) {
                if (c != holder || asker == null) return;
                if (t.equals("give") && asker.alive) holder = asker;
                else asker.send("{\"t\":\"denied\",\"name\":" + JSONObject.quote(c.name) + "}");
                asker = null;
                broadcastPen();
                return;
            }
            // everything below is drawing: only the pen holder may do it
            if (c != holder) { c.send(penJson()); return; }
            if (t.equals("add")) {
                JSONObject o = m.optJSONObject("obj");
                if (o == null || o.optString("id").length() == 0 || find(o.optString("id")) != null) return;
                objs.add(o);
                while (objs.size() > 4000) objs.remove(0);
                broadcast(text, c);
            } else if (t.equals("pts")) {
                JSONObject o = find(m.optString("id"));
                JSONArray pts = m.optJSONArray("pts");
                if (o == null || pts == null) return;
                JSONArray dst = o.optJSONArray("pts");
                if (dst == null) { dst = new JSONArray(); o.put("pts", dst); }
                for (int i = 0; i < pts.length(); i++) dst.put(pts.get(i));
                broadcast(text, c);
            } else if (t.equals("upd")) {
                JSONObject o = find(m.optString("id"));
                JSONObject props = m.optJSONObject("props");
                if (o == null || props == null) return;
                java.util.Iterator<String> keys = props.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    if (!k.equals("id") && !k.equals("type") && !k.equals("src")) o.put(k, props.get(k));
                }
                broadcast(text, c);
            } else if (t.equals("end") || t.equals("laser")) {
                broadcast(text, c);
            } else if (t.equals("del")) {
                JSONObject o = find(m.optString("id"));
                if (o == null) return;
                objs.remove(o);
                broadcast(text, c);
            } else if (t.equals("clear")) {
                objs.clear();
                broadcast(stateJson(), null);
            }
        }
    }

    private String cleanName(String n, Client c) {
        n = n == null ? "" : n.trim();
        if (n.length() > 24) n = n.substring(0, 24);
        return n.length() > 0 ? n : "Гость " + c.id;
    }

    private void onLeave(Client c) {
        synchronized (lock) {
            if (asker == c) asker = null;
            if (holder == c) {
                holder = null;
                if (asker != null && asker.alive) holder = asker;
                else for (Client o : clients) if (o.alive && o.role.equals("phone")) { holder = o; break; }
                if (asker == holder) asker = null;
            }
            broadcastPen();
        }
    }

    private String penJson() {
        int phones = 0;
        for (Client o : clients) if (o.alive && o.role.equals("phone")) phones++;
        Client h = holder != null && holder.alive ? holder : null;
        return "{\"t\":\"pen\",\"holder\":" + (h != null ? h.id : 0)
                + ",\"name\":" + JSONObject.quote(h != null ? h.name : "")
                + ",\"asking\":" + (asker != null ? asker.id : 0)
                + ",\"phones\":" + phones + "}";
    }

    private void broadcastPen() { broadcast(penJson(), null); }

    private JSONObject find(String id) {
        for (int i = objs.size() - 1; i >= 0; i--) if (objs.get(i).optString("id").equals(id)) return objs.get(i);
        return null;
    }

    private String stateJson() {
        StringBuilder sb = new StringBuilder(1024);
        sb.append("{\"t\":\"state\",\"a\":").append(aspect)
          .append(",\"url\":").append(JSONObject.quote(phoneUrl()))
          .append(",\"objs\":[");
        for (int i = 0; i < objs.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(objs.get(i).toString());
        }
        return sb.append("]}").toString();
    }

    private void broadcast(String json, Client except) {
        byte[] f = textFrame(json);
        for (Client c : clients) if (c != except) c.send(f);
    }

    // ---------------------------------------------------------------- helpers

    private static byte[] textFrame(String s) { return frame(0x81, s.getBytes(UTF8)); }

    private static byte[] frame(int first, byte[] payload) {
        int len = payload.length, h;
        byte[] f;
        if (len < 126) { f = new byte[2 + len]; f[1] = (byte) len; h = 2; }
        else if (len < 65536) { f = new byte[4 + len]; f[1] = 126; f[2] = (byte) (len >> 8); f[3] = (byte) len; h = 4; }
        else {
            f = new byte[10 + len]; f[1] = 127;
            for (int i = 0; i < 8; i++) f[2 + i] = (byte) (((long) len) >> (56 - 8 * i));
            h = 10;
        }
        f[0] = (byte) first;
        System.arraycopy(payload, 0, f, h, len);
        return f;
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int ch;
        while ((ch = in.read()) != -1) {
            if (ch == '\n') break;
            if (ch != '\r') sb.append((char) ch);
            if (sb.length() > 8192) throw new IOException("header too long");
        }
        if (ch == -1 && sb.length() == 0) return null;
        return sb.toString();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        } finally { in.close(); }
    }
}
