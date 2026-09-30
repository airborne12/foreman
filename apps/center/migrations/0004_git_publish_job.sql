-- 0004: 平台代做 git（git-publish 作业）
--
-- 背景：codex 的 workspace-write 沙箱会把所有 .git 目录设为只读（普通仓库也一样，writable_roots /
-- --add-dir 都绕不过），codex 在沙箱里无法提交、推送、建 PR（2026-09-30 T-77）。改为批准「创建 PR」后
-- 由 worker 在任务工作区里提交、推到用户 fork、建 PR：作业 kind=git-publish。

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('jira-poll', 'jira-lookup', 'jira-comment', 'gh-pr-view', 'merge-tree-check', 'candidate-scan', 'worktree-gc', 'dispatcher-idle', 'heartbeat-check', 'progress-watch', 'feishu-digest', 'notification-retry', 'code-locate', 'context-retry', 'dispatch', 'git-publish'));
