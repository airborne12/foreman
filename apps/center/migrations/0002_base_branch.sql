-- 0002: worktree 基线分支自适应
--
-- 背景：基线分支原本只按仓库配一个固定值（center.yaml 的 repo_base_branch），
-- 但每个任务要改的代码分支各不相同——T-6 的 search 降级代码在 branch-selectdb-doris-4.1，
-- T-5 的 SNII 只在 branch-hotfix-selectdb-cloud-4.1.7-minimax-rows，T-10 的用例只在 4.1 线。
-- 结果 agent 在 worktree 里根本找不到目标代码。
--
-- 改为：代码定位时判断出目标分支写入 triage_cards.base_branch，拍板（可覆盖）后落到
-- tasks.base_branch，worktree 从它拉；两者都为空时回退到 center.yaml 的仓库级默认。

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS base_branch TEXT;
ALTER TABLE triage_cards ADD COLUMN IF NOT EXISTS base_branch TEXT;

COMMENT ON COLUMN tasks.base_branch IS 'worktree 的基线分支（拍板后确定）；为空表示用 center.yaml 的 repo_base_branch 仓库级默认';
COMMENT ON COLUMN triage_cards.base_branch IS '代码定位判断出的目标分支；为空表示未判断出，拍板时可覆盖';
