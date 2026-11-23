package com.aster.mobile;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class SseEventParserTest {

    @Test
    public void parsesSseFramesAndIgnoresHeartbeats() {
        SseEventParser parser = new SseEventParser();
        List<String> seen = new ArrayList<>();

        parser.feedLine(": heartbeat", (e, d) -> seen.add(e + ":" + d));
        parser.feedLine("", (e, d) -> seen.add(e + ":" + d));
        assertTrue(seen.isEmpty());

        parser.feedLine("event: host.message", (e, d) -> seen.add(e + ":" + d));
        parser.feedLine("data: {\"source\":\"watch\",\"message\":{\"id\":\"m1\",\"text\":\"hi\"}}", (e, d) -> seen.add(e + ":" + d));
        parser.feedLine("", (e, d) -> seen.add(e + ":" + d));

        assertEquals(1, seen.size());
        assertTrue(seen.get(0).startsWith("host.message:"));
    }

    @Test
    public void extractsHostMessageTitleBySource() {
        SseEventParser.AlertPayload routine = SseEventParser.extractAlert(
            "host.message",
            "{\"source\":\"routine\",\"message\":{\"id\":\"10\",\"text\":\"今日简报已完成\"}}"
        );
        assertNotNull(routine);
        assertEquals("host:10", routine.dedupKey);
        assertEquals("Aster 定时任务", routine.title);
        assertEquals("今日简报已完成", routine.body);

        SseEventParser.AlertPayload watch = SseEventParser.extractAlert(
            "host.message",
            "{\"source\":\"watch\",\"message\":{\"id\":\"11\",\"text\":\"GitHub CI 失败\"}}"
        );
        assertNotNull(watch);
        assertEquals("Aster 监控动态", watch.title);

        SseEventParser.AlertPayload reminder = SseEventParser.extractAlert(
            "host.message",
            "{\"message\":{\"id\":\"12\",\"text\":\"下午三点开会\"}}"
        );
        assertNotNull(reminder);
        assertEquals("Aster 提醒", reminder.title);
    }

    @Test
    public void extractsApprovalAndIgnoresNonAlertEvents() {
        SseEventParser.AlertPayload approval = SseEventParser.extractAlert(
            "approval.requested",
            "{\"id\":\"apr-1\",\"toolName\":\"bash\",\"caller\":{\"kind\":\"subagent\",\"subagentId\":\"sub-2\"}}"
        );
        assertNotNull(approval);
        assertEquals("approval:apr-1", approval.dedupKey);
        assertEquals("需要你审批", approval.title);
        assertTrue(approval.body.contains("Sub-agent (sub-2)"));
        assertTrue(approval.body.contains("bash"));

        assertNull(SseEventParser.extractAlert("snapshot", "{}"));
        assertNull(SseEventParser.extractAlert("request.done", "{\"message\":{\"id\":\"1\",\"text\":\"ok\"}}"));
    }
}
