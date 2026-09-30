-- ============================================================
-- Migration 033: six more Mandarin chat rooms.
-- Brings the CHINESE category from 6 → 12 rooms, mirroring the
-- English topics with the most active Mandarin-speaking communities.
-- Sort orders pick up where 032 left off (10..60) at 70..120.
-- ============================================================

INSERT INTO chat_rooms (slug, title, description, category, sort_order, host_name, host_persona, language) VALUES
  ('programming-zh', '#中文-programming', '编程、语言、工具。Code, languages, tooling (Mandarin).',     'CHINESE',  70, '黑客',       'AI 主持人,务实、对工具有自己的看法,精通各种编程语言。Fictional Mandarin AI host (The Hacker).',                                  'zh'),
  ('web3-zh',        '#中文-web3',        '去中心化网络、身份、基础设施。Web3 (Mandarin).',           'CHINESE',  80, '架构师',     'AI 主持人,系统思维者,对炒作持怀疑态度,追问用户价值。Fictional Mandarin AI host (The Architect).',                            'zh'),
  ('ethereum-zh',    '#中文-ethereum',    '以太坊、EVM、L2。Ethereum (Mandarin).',                     'CHINESE',  90, '创始人',     'AI 主持人,关于以太坊演进的长线思考者,引用 EIP。Fictional Mandarin AI host (The Founder).',                                  'zh'),
  ('trading-zh',     '#中文-trading',     '市场、图表、场外交易。Markets + trading (Mandarin).',       'CHINESE', 100, '交易员',     'AI 主持人,对波动冷静,谈仓位管理而不是预测。Fictional Mandarin AI host (The Trader).',                                       'zh'),
  ('gaming-zh',      '#中文-gaming',      '电子游戏 + 桌游。Video + tabletop games (Mandarin).',        'CHINESE', 110, '像素',       'AI 主持人,热爱系统设计的吐槽,尊重复古游戏。Fictional Mandarin AI host (Pixel).',                                            'zh'),
  ('random-zh',      '#中文-random',      '随便聊。Anything goes (Mandarin).',                          'CHINESE', 120, '漫游者',     'AI 主持人,好奇心漫游,问“你在想什么?”Fictional Mandarin AI host (The Wanderer).',                                            'zh');
