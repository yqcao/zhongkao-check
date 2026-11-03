// 赤峰中考诊断 — 科目与模块注册表。最先加载；题库文件在其后向 ZK.banks 推送题目。
// pts = 该模块在中考该科中约占的分值；manual = 网站无法测的部分（作文、实验操作等），由家长填写。
window.ZK = window.ZK || { subjects: [], banks: [] };

ZK.exam = {
  name: "赤峰市中考（内蒙古自治区统一命题）",
  year: 2027,
  total: 660,
  // 网站之外的计分项，家长在“预估总分”里填写。
  extras: [
    { id: "pe", name: "体育与健康", full: 80, note: "七、八、九年级阶段测试 + 日常参与 + 专项技能" },
    { id: "geobio", name: "地理 + 生物学（初二已考）", full: 60, note: "填写 2026 年 6 月的实际成绩" },
  ],
  targets: [
    { name: "赤峰二中（普通班，稳妥）", score: 615, note: "非官方估计：近两年红山区约 604–616" },
    { name: "赤峰二中和美分校（中心城区）", score: 585, note: "2026 年官方控制线" },
    { name: "赤峰一中", score: 540, note: "2026 年官方控制线" },
    { name: "普通高中最低控制线", score: 360, note: "2026 年官方控制线" },
  ],
};

// 四个难度层级，对应中考试卷的“易、中、较难、难”。
ZK.levels = [
  { n: 1, name: "基础", can: "掌握课本基本概念和公式，能做中考容易题（课本例题难度）。" },
  { n: 2, name: "中档", can: "能稳定做对中考常规中档题，知识点能灵活运用。" },
  { n: 3, name: "较难", can: "能解决中考综合题，多个知识点联合运用、步骤较多。" },
  { n: 4, name: "压轴", can: "能攻克压轴与拔高题，是冲刺赤峰二中所需的水平。" },
];
// 某模块达到某层级时，预计能拿到该模块分值的比例（粗略模型，用于估分）。
ZK.levelShare = [0.3, 0.55, 0.75, 0.9, 0.98];

ZK.subjects = [
  {
    id: "yw", name: "语文", full: 100, color: "--s-yw",
    modules: [
      { id: "yw.zici", name: "字音字形与词语", pts: 6, kind: "items", about: "字音、字形、多音字、易错字，词语与成语的理解和使用。" },
      { id: "yw.yuyan", name: "语言运用", pts: 8, kind: "items", about: "病句辨析与修改、标点、句子衔接与排序、修辞、综合性学习。" },
      { id: "yw.moxie", name: "古诗文积累", pts: 7, kind: "items", about: "课内古诗文名句默写（选择形式）与理解性默写。" },
      { id: "yw.mingzhu", name: "名著阅读", pts: 5, kind: "items", about: "统编教材必读名著的人物、情节、主题与阅读方法。" },
      { id: "yw.wenyan", name: "文言文阅读", pts: 10, kind: "passage", about: "实词虚词、句子翻译、内容理解与课内外比较阅读。" },
      { id: "yw.shici", name: "古诗词鉴赏", pts: 5, kind: "passage", about: "诗词的意象、情感、手法与炼字赏析。" },
      { id: "yw.xdw1", name: "记叙文与散文阅读", pts: 10, kind: "passage", about: "情节梳理、人物形象、语言品味、写作手法与主旨。" },
      { id: "yw.xdw2", name: "说明文、议论文与非连续性文本", pts: 9, kind: "passage", about: "说明方法与对象、论点论据论证、图表与多则材料信息提取。" },
    ],
    manual: [{ id: "yw.zuowen", name: "作文", pts: 40, note: "网站无法自动评分，请老师或家长按中考评分标准打分" }],
  },
  {
    id: "sx", name: "数学", full: 100, color: "--s-sx",
    modules: [
      { id: "sx.shu", name: "数与式", pts: 14, kind: "items", about: "实数、科学记数法、整式与因式分解、分式、二次根式。" },
      { id: "sx.fangcheng", name: "方程与不等式", pts: 14, kind: "items", about: "一元一次与一元二次方程、方程组、分式方程、不等式（组）及应用题。" },
      { id: "sx.hanshu", name: "函数", pts: 22, kind: "items", about: "平面直角坐标系、一次函数、反比例函数、二次函数及其综合。" },
      { id: "sx.sanjiao", name: "三角形与四边形", pts: 18, kind: "items", about: "全等、等腰与直角三角形、勾股定理、平行四边形与特殊四边形。" },
      { id: "sx.yuan", name: "圆", pts: 10, kind: "items", about: "垂径定理、圆周角、切线的判定与性质、弧长与扇形面积。" },
      { id: "sx.bianhuan", name: "相似、三角函数与图形变化", pts: 12, kind: "items", about: "相似三角形、锐角三角函数与解直角三角形、平移旋转轴对称、投影与视图。" },
      { id: "sx.tongji", name: "统计与概率", pts: 10, kind: "items", about: "统计图表、平均数中位数众数方差、用列表或树状图求概率。" },
    ],
    manual: [],
  },
  {
    id: "yy", name: "英语", full: 100, color: "--s-yy",
    modules: [
      { id: "yy.tingli", name: "听力", pts: 10, kind: "passage", listen: true, about: "听对话和短文回答问题（由设备朗读，可听两遍）。" },
      { id: "yy.danxuan", name: "单项选择（词汇与语法）", pts: 10, kind: "items", about: "时态语态、非谓语、从句、介词、代词、情景交际。" },
      { id: "yy.cihui", name: "词汇运用", pts: 10, kind: "items", about: "词形变化、词义辨析、固定搭配、语境中选词。" },
      { id: "yy.wanxing", name: "完形填空", pts: 15, kind: "passage", about: "在语篇中根据上下文选择最合适的词语。" },
      { id: "yy.yuedu", name: "阅读理解", pts: 35, kind: "passage", about: "细节理解、推理判断、主旨大意、词义猜测、作者意图。" },
    ],
    manual: [{ id: "yy.xiezuo", name: "书面表达", pts: 20, note: "网站无法自动评分，请老师或家长评分" }],
  },
  {
    id: "wl", name: "物理", full: 70, color: "--s-wl",
    modules: [
      { id: "wl.shengguang", name: "声与光", pts: 7, kind: "items", about: "声音的产生与特性、光的反射折射、透镜成像规律。" },
      { id: "wl.re", name: "热学", pts: 7, kind: "items", about: "物态变化、内能与比热容、热机与热值、能量守恒。" },
      { id: "wl.li", name: "力与运动", pts: 9, kind: "items", about: "机械运动与速度、质量与密度、力、重力、摩擦力、牛顿第一定律、二力平衡。" },
      { id: "wl.yaqiang", name: "压强与浮力", pts: 10, kind: "items", about: "固体与液体压强、大气压、流体压强、阿基米德原理与浮沉条件。" },
      { id: "wl.gong", name: "功、机械能与简单机械", pts: 9, kind: "items", about: "功和功率、动能势能转化、杠杆、滑轮、机械效率。" },
      { id: "wl.dianlu", name: "电路与欧姆定律", pts: 11, kind: "items", about: "电路连接、电流电压电阻、欧姆定律、动态电路与电路故障。" },
      { id: "wl.diangong", name: "电功率、电与磁", pts: 7, kind: "items", about: "电功与电功率、焦耳定律、家庭电路与安全用电、电磁现象。" },
    ],
    manual: [{ id: "wl.shiyan", name: "实验操作考试", pts: 10, note: "学校组织的实验操作考试，一般能拿满分" }],
  },
  {
    id: "hx", name: "化学", full: 50, color: "--s-hx",
    modules: [
      { id: "hx.goucheng", name: "物质构成与化学用语", pts: 8, kind: "items", about: "分子原子离子、元素与元素周期表、化学式与化合价、物质分类。" },
      { id: "hx.kongqi", name: "空气、氧气、水与碳", pts: 7, kind: "items", about: "空气组成、氧气与二氧化碳的性质和制取、水的组成与净化、燃烧与灭火。" },
      { id: "hx.jinshu", name: "金属与溶液", pts: 7, kind: "items", about: "金属的性质与活动性顺序、锈蚀与防护、溶液、溶解度曲线。" },
      { id: "hx.suanjian", name: "酸、碱、盐", pts: 8, kind: "items", about: "常见酸碱盐的性质、中和反应与 pH、复分解反应、化肥、物质的检验与除杂。" },
      { id: "hx.fangcheng", name: "化学方程式与计算", pts: 5, kind: "items", about: "质量守恒定律、方程式书写与反应类型、根据方程式与溶质质量分数计算。" },
      { id: "hx.shiyan", name: "实验与科学探究", pts: 5, kind: "items", about: "基本操作、仪器使用、实验方案的设计与评价、探究题。" },
    ],
    manual: [{ id: "hx.shiyan-op", name: "实验操作考试", pts: 10, note: "学校组织的实验操作考试，一般能拿满分" }],
  },
  {
    id: "df", name: "道德与法治", full: 50, color: "--s-df",
    modules: [
      { id: "df.chengzhang", name: "成长与心理（七年级）", pts: 7, kind: "items", about: "青春期、情绪管理、友谊、师生与亲子关系、生命的意义。" },
      { id: "df.shehui", name: "社会生活与道德（八上）", pts: 7, kind: "items", about: "网络生活、社会规则、诚信与礼貌、责任与担当、国家利益。" },
      { id: "df.fazhi", name: "宪法与法治", pts: 12, kind: "items", about: "宪法地位与原则、公民基本权利与义务、国家机构、未成年人保护与违法犯罪。" },
      { id: "df.guoqing", name: "国情与国策（九上）", pts: 13, kind: "items", about: "改革开放、创新驱动、民主与法治、文化自信、生态文明、民族团结与国家统一。" },
      { id: "df.shijie", name: "世界与中国（九下）", pts: 11, kind: "items", about: "世界格局、中国担当、人类命运共同体、走向未来的少年。" },
    ],
    manual: [],
  },
  {
    id: "ls", name: "历史", full: 50, color: "--s-ls",
    modules: [
      { id: "ls.gudai", name: "中国古代史", pts: 11, kind: "items", about: "从史前到明清：国家统一、民族交融、经济重心南移、科技文化、制度演变。" },
      { id: "ls.jindai", name: "中国近代史", pts: 11, kind: "items", about: "鸦片战争到新中国成立：列强侵华、近代化探索、新民主主义革命、抗日战争。" },
      { id: "ls.xiandai", name: "中国现代史", pts: 9, kind: "items", about: "新中国的巩固与建设、改革开放、民族团结与祖国统一、国防外交、科技成就。" },
      { id: "ls.shijiegu", name: "世界古代与中古史", pts: 6, kind: "items", about: "大河文明、古希腊罗马、封建社会、亚洲国家、文化交流与新航路开辟前的世界。" },
      { id: "ls.shijiejin", name: "世界近代史", pts: 7, kind: "items", about: "文艺复兴、新航路、资产阶级革命、工业革命、马克思主义、殖民扩张与民族解放。" },
      { id: "ls.shijiexian", name: "世界现代史", pts: 6, kind: "items", about: "两次世界大战、苏联建设、经济大危机与罗斯福新政、冷战、经济全球化。" },
    ],
    manual: [],
  },
];

// 题库文件（相对 content/）。引擎按顺序加载。
ZK.files = ["yw.jilei", "yw.yuedu", "sx", "yy.jichu", "yy.yuedu", "wl", "hx", "df", "ls"];
