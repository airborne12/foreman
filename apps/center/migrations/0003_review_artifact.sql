-- 0003: review 结论作为一类产物
--
-- 背景：review 子任务没有自己的产物类型，只能用 report_progress 写进展。2026-09-29 T-81.2 的
-- codex 想把 review 结论正式回写，只能拿 kind=pr 去交，而交 pr 会给「review 子任务」再建
-- PR / review 孙任务，撞上 tasks_key_check（任务号只允许一级子任务），连试 6 种写法都失败。
--
-- 改为：新增 kind=review，内容为结论（verdict）、必须修 / 建议修清单与全文；不派生子任务。

ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check CHECK (kind IN ('pr', 'doc', 'branch', 'triage', 'candidates', 'review'));
COMMENT ON COLUMN artifacts.kind IS '产物类型：pr / doc / branch / triage / candidates / review（review 子任务的结论，payload 含 verdict、mustFix、suggestions）';
