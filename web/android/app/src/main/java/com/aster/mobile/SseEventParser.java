package com.aster.mobile;

import org.json.JSONObject;

/**
 * Stateful line-by-line SSE parser + alert payload extractor for the Android keep-alive service.
 * Pure Java (no Android runtime dependencies) so it can be unit-tested directly with JUnit.
 */
public final class SseEventParser {

    public static final int MAX_SUMMARY_CHARS = 80;

    public interface EventListener {
        void onEvent(String eventType, String data);
    }

    public static final class AlertPayload {
        public final String dedupKey;
        public final String title;
        public final String body;

        public AlertPayload(String dedupKey, String title, String body) {
            this.dedupKey = dedupKey;
            this.title = title;
            this.body = body;
        }
    }

    private String currentEvent = "message";
    private final StringBuilder dataBuffer = new StringBuilder();

    public void feedLine(String line, EventListener listener) {
        if (line == null) return;
        if (line.isEmpty()) {
            flush(listener);
            return;
        }
        if (line.startsWith(":")) {
            // Comment / heartbeat line
            return;
        }
        if (line.startsWith("event:")) {
            currentEvent = line.substring(6).trim();
        } else if (line.startsWith("data:")) {
            String value = line.substring(5);
            if (value.startsWith(" ")) {
                value = value.substring(1);
            }
            if (dataBuffer.length() > 0) {
                dataBuffer.append('\n');
            }
            dataBuffer.append(value);
        }
    }

    public void flush(EventListener listener) {
        if (dataBuffer.length() > 0) {
            String event = currentEvent.isEmpty() ? "message" : currentEvent;
            String data = dataBuffer.toString();
            dataBuffer.setLength(0);
            currentEvent = "message";
            listener.onEvent(event, data);
        } else {
            currentEvent = "message";
        }
    }

    public static String truncateSummary(String text, int maxChars) {
        if (text == null) return "";
        String compact = text.replaceAll("\\s+", " ").trim();
        if (compact.length() <= maxChars) return compact;
        return compact.substring(0, maxChars).trim() + "…";
    }

    public static String hostMessageTitle(String source) {
        if ("routine".equals(source)) return "Aster 定时任务";
        if ("watch".equals(source)) return "Aster 监控动态";
        return "Aster 提醒";
    }

    /**
     * Converts a server SSE frame into a high-priority Android notification payload, or returns
     * null when the event does not require a background heads-up notification.
     */
    public static AlertPayload extractAlert(String eventType, String rawJson) {
        if (eventType == null || rawJson == null || rawJson.isEmpty()) return null;
        try {
            if ("host.message".equals(eventType)) {
                JSONObject root = new JSONObject(rawJson);
                JSONObject message = root.optJSONObject("message");
                if (message == null) return null;
                String id = message.optString("id", "");
                String text = message.optString("text", "");
                String source = root.optString("source", "");
                String title = hostMessageTitle(source);
                String body = text.trim().isEmpty()
                    ? "收到一条新提醒"
                    : truncateSummary(text, MAX_SUMMARY_CHARS);
                String key = id.isEmpty() ? "host:" + body.hashCode() : "host:" + id;
                return new AlertPayload(key, title, body);
            }

            if ("approval.requested".equals(eventType)) {
                JSONObject root = new JSONObject(rawJson);
                String id = root.optString("id", "");
                String toolName = root.optString("toolName", "敏感操作");
                JSONObject caller = root.optJSONObject("caller");
                String callerLabel = "Main Agent";
                if (caller != null && "subagent".equals(caller.optString("kind", ""))) {
                    String subId = caller.optString("subagentId", "");
                    callerLabel = subId.isEmpty() ? "Sub-agent" : "Sub-agent (" + subId + ")";
                }
                String body = truncateSummary(
                    callerLabel + " · " + toolName + "（请进入应用查看详情）",
                    MAX_SUMMARY_CHARS
                );
                String key = id.isEmpty() ? "approval:" + body.hashCode() : "approval:" + id;
                return new AlertPayload(key, "需要你审批", body);
            }

            if ("credential.request".equals(eventType)) {
                JSONObject root = new JSONObject(rawJson);
                String requestId = root.optString("requestId", "");
                String provider = root.optString("provider", "连接器");
                String tool = root.optString("tool", "");
                String body = truncateSummary(
                    tool.isEmpty() ? provider : (provider + " · " + tool),
                    MAX_SUMMARY_CHARS
                );
                String key = requestId.isEmpty() ? "cred:" + body.hashCode() : "cred:" + requestId;
                return new AlertPayload(key, "需要凭据授权", body);
            }
        } catch (Exception ignored) {
            return null;
        }
        return null;
    }
}
