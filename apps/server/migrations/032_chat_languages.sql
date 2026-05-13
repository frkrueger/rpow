-- ============================================================
-- Migration 032: ChatRooms language enforcement.
-- Adds the `language` column on chat_rooms so each room can be
-- gated to a single language. The AI host (slice 2 runtime) reads
-- room.language and mutes users who post in any other language —
-- "kicked" in user-facing copy.
--
-- Existing 21 rooms default to 'en'. Six new rooms are seeded for
-- Mandarin Chinese with their own host personas.
-- ============================================================

ALTER TABLE chat_rooms
  ADD COLUMN language TEXT NOT NULL DEFAULT 'en';

-- New CHINESE category. Slugs use the `-zh` suffix so they coexist
-- cleanly with the English originals. Categories carry "CHINESE 中文"
-- prefix so the sidebar groups them under their own header.
INSERT INTO chat_rooms (slug, title, description, category, sort_order, host_name, host_persona, language) VALUES
  ('general-zh',    '#中文-general',   '中文聊天室。Catch-all lounge (Mandarin).',         'CHINESE',   10, '万维网',       'AI 主持人,灵感来源于互联网先驱。欢迎所有人,把跑题的对话引回主题。AI host persona for the Mandarin general room.',                                                          'zh'),
  ('rpow-zh',       '#中文-rpow',      'rpow2 公告与讨论。rpow2 announcements (Mandarin).', 'CHINESE',   20, '哈尔',         'AI 主持人,灵感来源于 Hal Finney。深思熟虑、技术性强、密码朋克历史背景。AI host inspired by Hal Finney, writing in Mandarin.',                                                'zh'),
  ('technology-zh', '#中文-technology','广义技术讨论。Broad tech talk (Mandarin).',          'CHINESE',   30, '艾达',         'AI 主持人,灵感来源于第一位程序员 Ada Lovelace。好奇事物如何运作,喜欢设计图。AI host inspired by Ada Lovelace, writing in Mandarin.',                                          'zh'),
  ('ai-zh',         '#中文-ai',        '人工智能、大语言模型、智能体。AI / LLMs (Mandarin).', 'CHINESE',   40, '图灵',         'AI 主持人,灵感来源于 Alan Turing。质疑假设,问“测试方法是什么?”AI host inspired by Turing, writing in Mandarin.',                                                          'zh'),
  ('bitcoin-zh',    '#中文-bitcoin',   '比特币 + 闪电网络。Bitcoin + Lightning (Mandarin).', 'CHINESE',   50, '中本聪',       'AI 主持人,灵感来源于中本聪化名。简洁,偏好源代码胜过猜测。AI host inspired by Satoshi, writing in Mandarin.',                                                                'zh'),
  ('solana-zh',     '#中文-solana',    'Solana 生态。Solana ecosystem (Mandarin).',          'CHINESE',   60, '阿纳托利',     'AI 主持人,灵感来源于 Anatoly Yakovenko。注重性能,快速发表对验证者与 tps 的看法。AI host inspired by Anatoly Yakovenko, writing in Mandarin.',                                'zh');
