import { useLocation, useNavigate } from "react-router-dom";
import { useApprovalStore } from "@/store/approvals";
import { ApprovalCapsuleItem } from "./ApprovalActionCard";

/**
 * 跨页面非阻塞审批胶囊：
 * - 在对话页 `/` 时不渲染（Main 审批内联在对话流，Sub-agent 审批内嵌在 SubagentPanel）；
 * - 在「连接器」「设置」等其他页面时，底部居中轻悬浮出现，点击即可就地展开审批或一键跳回对话页，零遮罩不阻塞当前页。
 */
export function FloatingApprovalCapsule() {
  const location = useLocation();
  const navigate = useNavigate();
  const pending = useApprovalStore((state) => state.pending);

  if (location.pathname === "/" || pending.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-3 safe-bottom sm:px-6"
      role="region"
      aria-label="待处理敏感操作审批"
    >
      <div className="pointer-events-auto w-full max-w-lg">
        <ApprovalCapsuleItem
          approvals={pending}
          defaultExpanded={false}
          className="shadow-xl"
          trailingLink={
            <button
              type="button"
              onClick={() => navigate("/")}
              className="rounded-full px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-accent"
            >
              对话
            </button>
          }
        />
      </div>
    </div>
  );
}
