# 伦敦华人日常需求：Codex直接搜索 vs Telegram Bot

2026-10-12｜24个固定模拟需求｜Bot 0.13.2｜真实Telegram两人测试群｜测试中未修改运行策略

**当前优先修复请求状态、供需角色和硬条件绑定，再改进推荐实体与展示。**

## 方法与边界

先固定二手5、住房3、帮带2、搭子3、文化活动2、吃喝2、亲子1、生活服务3、日常办事2、出行1，共24例。A直接拆词、读公开文本、人工综合，不运行Bot规划/排序；二手/住房/帮带/搭子使用同一A2H公开API。其他题尝试Sandbase，小红书429时转官网/公开网页。

B从已登录的真人Telegram账号发到原两人测试群，经真实入站、Jev、agent、门和sender，DB确认sent并多次UI核对。保留同一用户的真实历史，不重置session，不伪造入站、不联系帖子作者。冻结0.13.2，不因失败重跑覆盖结果。G2第一批UI未提交，补发后才计唯一实际run。

同一Codex查询/综合/评分，发送中见过部分B UI，完整B正文在A写定后集中核对；**非盲评，不是随机线上A/B实验，不代表真人满意率**。A与B能力/模型/成本不同，13例同A2H源子集单列。来源数据仍可能过期或有转载摘要错误，帖载能力不当实物确认。本轮只测文字单轮，未测图片、语音、后续追问、真实成交或实地服务质量。

每维0–4：匹配、来源/时效、实用信息、选择/下一步、阅读，共20。另给满足等级：0无相关帮助，1弱线索，2可推进但关键条件未知，3大体可行动，4核心已明确支持/完整办事步骤。静默0；已知硬条件冲突不能拿待确认掩盖；差1分算平。

B发出回复者中位52.7秒，最短9.2、最长112.2秒，含批次排队。不拿A仅API耗时作速度对照。

## 11条静默的真实终点

|数量|案例|终点|
|---:|---|---|
|1|G1 小绿锅|入站Jev timeout，按合同不放行|
|1|G2 无线激光打印机|MaxTurnsExceededError，12轮耗尽|
|1|H1 E14长租|market_search原始JSON错误，publishApproval解析异常，重试被duplicate_delivery挡下|
|2|L1 看展、L2 免费活动|Sandbase /search-notes 429被转换为空列表，模型do_nothing|
|4|L3 火锅、L4 点心、L5 亲子、A1 超市|已经web_search，出站worthReplying分别0.02/0.02/0.01/0.24，drop|
|2|A2 GP、A3 机场|入站放行，模型以类别不支持主动do_nothing|

四个web案例没有upsert本轮需求。最新other建档仍为03:55 UTC的carry-on help Shanghai to London，web出站仍使用ctx.demand；符合P20在A2H修过、在web分支尚存的旧需求污染路径。不能将所有静默归为无结果，也不应取消Jev或放宽门掩盖。

## 内容差距与Bot的正例

- **G3：具体物品。** A同源找到E14同帖桌£30/椅£20。B选整套帖，引文有桌10/椅45，却显示单品价未知，并混入伦敦东南椅子。10个发出回复的A2H案例全部primaryRefs为空，只给备选。
- **G4：查询拆分。** A用显示器+USB-C短词召回ARZOPA M1RC £60/27寸/帖载USB-C。B把27、inch、monitor、USB-C、伦敦组合，工具结果没有该物品。只证明这条帖子可召回，接口实物/视频与充电仍须核对，品牌通用FAQ不能验证该型号。
- **C2：角色/日期。** 用户11月1日伦敦飞上海、有容量，要找需求方。A查BUY；B方向规则给SELL并覆盖模型BUY查询；模型日期扩大到10月25–11月8日，最后推荐另一位11月8日提供者。
- **C1/H2：硬条件。** B将10月17日帮带放进11月候选，将Studio放进一居室整租候选。未知年份或宠物政策可以解释，已知月份/房型不符应剔除。
- **日常咨询口径。** A按[NHS官方注册](https://www.nhs.uk/nhs-services/gps/how-to-register-with-a-gp-surgery/)与[Heathrow到达时间](https://www.heathrow.com/departures/checking-in)形成步骤；B入站认可后agent又以类别不支持沉默。
- **故障降级。** A五题小红书均无数据，单次复核两个HTTP429，B原日志也记录429。A改查展馆官网，B看展/活动不回。未推断429是额度还是并发，不把此项冒充相同来源下的模型胜负。
- **固定商家库有价值。** S2 B给£180一居室指导价与联系入口，[Good Old Clean官网](https://goodoldclean.co.uk/end-of-tenancy-cleaning/paddington/)其他伦敦区支持该参考价；A只找到超预算候选，B胜，E14实际总价/invoice仍待确认。S3 B给两位具体PAX安装者，[Italian Tasker](https://theitaliantasker.co.uk/)的£65起与PAX业务有官方支持，[Flatout](https://flatouthomeservices.co.uk/flatoutpros/ikea-pax-wardrobe-with-add-on-unit/)也有PAX案例；比A只给Taskrabbit入口具体，两者差1分判平。£100够的说法仍需按组合报价。
- **阅读/链接。** P19将日期与来源合为一行，formatter仅处理“来源：”开头，群里实际展开长URL及Markdown括号。A S2初稿也写错一条官网路径，已保留originalDraftUrl、记录正确路径并扣分，不只挑B的错。

## 优先改造与验收

|优先级|改造|本轮验收|
|---|---|---|
|P0|当前请求独立建模，搜索/出站绑定本轮sourceMessageId与需求；无效JSON返回纠错而非坏审批卡|H1不崩；L3/L4/L5/A1不再用帮带需求评估；Jev失效仍按合同安全降级且可观察|
|P0|先明确用户角色；日期、邮区、每件预算不能被模型放宽|C2 BUY/11月1日；G3 E14/每件50；C1已知10月不放进11月|
|P1|抽出offer实体、单品价、单品状态，同帖多物品分别核对，展览跨帖合并|G3清楚报价；G1已出物品剔除；L1按展览分类而非笔记排列|
|P1|短核心词+同义词，偏好另查；来源错误/空结果/有结果三态；官方办事源优先|G4短词找到候选；小红书429有状态/允许的官方降级；A2/A3可按官方程序性事实回应|
|P2|短卡、明确满足/不合适/未知、可信短链接和更新时间|没有全屏长URL、标签标题和无理由统一备选；商家起价不作定价|

**本轮仅评测，这些改造未实施。** 改完应完整重跑24例并追加新场景，保留旧失败。A也有住房/帮带/搭子关键条件未知及S2链接/预算问题，不是24题全满足。

## 实际评分汇总

|指标|A：直接搜索|B：真实Telegram|
|---|---:|---:|
|有回答|24/24（报告）|13/24（sent）|
|平均总分 /20|16.2|5.0|
|满足等级≥3|9/24|1/24|
|等级4|3/24|0/24|
|13例同A2H源平均 /20|15.6|5.8|

A胜22例、B胜1例、平1例。B已回复13例平均9.2/20；同A2H且B已回复10例，A平均15.5、B平均7.6，差距不只来自静默或官网能力。

## 24例总表

|ID|类型|原问题|A/20|B/20|满足等级 A/B|判定|
|---|---|---|---:|---:|---|---|
|G1|二手|伦敦想收一个小绿锅，预算20镑，最好Camberwell方便自取。|16|0|3/0|A|
|G2|二手|伦敦收激光打印机，预算60镑，必须支持无线打印。|15|0|2/0|A|
|G3|二手|E14想收书桌和办公椅，每件50镑以内，能自提。|19|9|3/2|A|
|G4|二手|伦敦想买27寸二手显示器，预算80镑，最好有USB-C。|18|10|3/3|A|
|G5|二手|我在E14有一张宜家书桌想卖30镑，帮我找正在求购书桌的买家。|15|8|2/1|A|
|H1|住房|E14找长租单间，2026年11月初入住，月租1200镑以内。|17|0|2/0|A|
|H2|住房|Stratford想找允许养猫的一居室整租，月租1600镑以内，11月入住。|15|8|2/1|A|
|H3|住房|刚到KCL读书，想找室友一起合租，Waterloo通勤30分钟内，预算每人1100镑一个月。|16|9|2/2|A|
|C1|帮带|找2026年11月上海飞伦敦的帮带，想带2公斤衣服。|16|7|2/1|A|
|C2|帮带|我2026年11月1日伦敦飞上海，有2公斤空余行李，帮我找需要帮带的人。|14|3|2/0|A|
|P1|搭子|E14想找周末羽毛球搭子，我是初学者，有适合新手的吗？|13|7|1/1|A|
|P2|搭子|10月17日想在Greenwich散步两小时，找个一起走走聊天的搭子。|15|9|2/2|A|
|P3|搭子|想在伦敦找英语口语练习搭子，工作日晚上，Soho附近最好。|14|6|2/1|A|
|L1|文化活动|伦敦这个月有什么值得看的展？帮我按艺术、摄影、沉浸式分一分。|19|0|3/0|A|
|L2|文化活动|2026年10月17到18日伦敦有什么免费活动，白天可以去的？|19|0|4/0|A|
|L3|吃喝|四个人想在伦敦唐人街吃火锅，人均30镑左右，有什么推荐？|15|0|2/0|A|
|L4|吃喝|Liverpool Street附近想吃早茶点心，人均25镑左右，推荐两三家。|16|0|2/0|A|
|L5|亲子|伦敦周末下雨，想带5岁小朋友去室内玩，免费或每人15镑以内。|20|0|4/0|A|
|S1|生活服务|10月24日从E14搬到SE1，8箱加一张书桌，预算120镑，想找能中文沟通的man and van。|16|13|2/2|A|
|S2|生活服务|10月31日E14一居室退租清洁，需要invoice，预算180镑，有推荐吗？|13|15|1/2|B|
|S3|生活服务|SE16想找人安装IKEA PAX衣柜，预算100镑，有推荐吗？|16|15|2/2|tie|
|A1|日常办事|刚搬到SE1，附近有能买豆腐、火锅底料和青菜的中国超市吗？想线下买。|16|0|3/0|A|
|A2|日常办事|刚到伦敦住E14，还没有NHS number，怎么注册GP？需要带什么，附近哪里能注册？|20|0|4/0|A|
|A3|出行|住E14，10月17日早上8点希思罗T2的航班，两件大行李，怎么去机场合适？|17|0|3/0|A|

## 逐例回答与证据

### G1 · 伦敦想收一个小绿锅，预算20镑，最好Camberwell方便自取。

A 16/20，等级3；B 0/20，等级0。维度匹配/来源/实用/决策/阅读：A [3, 3, 3, 3, 4]，B [0, 0, 0, 0, 0]。

**A独立回答**

我没在本次召回里确认Camberwell的现成供给，先看两条在预算内的备选：象堡白色小绿锅£10，帖主称很新；London Bridge小绿锅£5，用过一年、称功能正常并送厨房小物。想省预算选后者，想成色较新先问前者。取前确认是否仍在、内胆和通电状态；我排除了原文写“已出”的小绿锅。

来源：
- [象堡出二手小绿锅等](https://a2hmarket.ai/listings/listing_01M2M4VKFZPZ30E7TNE3FTAJKM)：小绿锅单品£10，象堡
- [London bridge出小绿锅5p｜£5](https://a2hmarket.ai/listings/listing_01M1N7XSFEQJHFN0HSFJGRY0V2)：小绿锅£5，London Bridge

**B真实结果**

未回复。终点：{"reason": "timeout", "outcome": "dropped_by_jev"}

**核对：** A有预算内两条真实供给；B入站Jev超时沉默。

### G2 · 伦敦收激光打印机，预算60镑，必须支持无线打印。

A 15/20，等级2；B 0/20，等级0。维度匹配/来源/实用/决策/阅读：A [2, 4, 2, 3, 4]，B [0, 0, 0, 0, 0]。

**A独立回答**

本次没确认到同时满足“激光＋无线＋≤£60”的供给。E14有HP激光£50，但没写型号和无线；象堡三星黑白激光£40，原文说两年没使用，无线也不明。它们只能是待核实线索，不能算已匹配。先让贴主提供完整型号和手机经Wi-Fi打印的视频，再核对耗材；我没有用£18的佳能喷墨来替代你明确要的激光机。

来源：
- [伦敦狗岛canary wharf E14白菜价出二手｜£0.5–£50](https://a2hmarket.ai/listings/listing_01M0RYT6K5V40Z1M8KKCJG7P96)：HP激光£50，wifi未知
- [伦敦二手出闲置 2.0 低价打折 【象堡】｜£15–£40](https://a2hmarket.ai/listings/listing_01M1G12AT52BAX4NAKP4J7WG62)：三星激光£40，两年未使用

**B真实结果**

未回复。终点：{"error": "MaxTurnsExceededError", "outcome": "agent_failed"}

**核对：** 没有确证激光+无线+£60内；A说明缺口/排除喷墨；B循环12轮后失败。

### G3 · E14想收书桌和办公椅，每件50镑以内，能自提。

A 19/20，等级3；B 9/20，等级2。维度匹配/来源/实用/决策/阅读：A [4, 3, 4, 4, 4]，B [2, 3, 2, 1, 1]。

**A独立回答**

优先看东伦敦E14同帖宜家办公桌£30、办公椅£20：两件分别在£50内，且只限自提，一次可以取齐。省预算的拆选是E14的120×60桌£10加狗岛黑色办公椅£10，但要跑两处；椅子皮面有使用褶皱。Canning Town桌椅整套£50的帖子说E14可以送，但自取地点不能直接当E14，先核实地址。确认两件都在、尺寸、能否拆桌再约取。

来源：
- [东伦敦E14 搬家出好物 🥬价](https://a2hmarket.ai/listings/listing_01M39KFDM4FD5SFNB5VR87QKDR)：同帖桌£30椅£20，E14自提
- [120x60书桌](https://a2hmarket.ai/listings/listing_01M2Y9FA1TBR7KPD1ZBNZ0FGBR)：120×60桌£10，E14
- [狗岛E14出宜家办公椅十磅自提](https://a2hmarket.ai/listings/listing_01M2HCVRN4TRGFCC3ATD289T1Z)：办公椅£10，狗岛E14

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 这次搜索还没找到关键条件都能确认的供给。下面3条可作备选，先核实标出的信息。

**核对：** A同帖桌£30椅£20在E14；B预算分项读不出，混入东南伦敦椅子，全部备选。

### G4 · 伦敦想买27寸二手显示器，预算80镑，最好有USB-C。

A 18/20，等级3；B 10/20，等级3。维度匹配/来源/实用/决策/阅读：A [3, 3, 4, 4, 4]，B [3, 3, 2, 1, 1]。

**A独立回答**

优先看UCL自提的ARZOPA M1RC：帖内写27寸、2K、180Hz、USB-C接口，£60，预算和偏好都较贴近；USB-C是否支持你电脑的视频输出及充电仍要确认。便宜备选为E3 Samsung 27寸M50A £40，帖子没确认USB-C。Hammersmith三星27寸曲面£45带HDMI转Type-C线，但转接线不等于屏幕有原生USB-C。取前确认接口实拍、坏点与供电方式。

来源：
- [ARZOPA M1RC显示器](https://a2hmarket.ai/listings/listing_01M2HMQC29P0BS21QWVGCVH6X2)：27寸£60，帖写USB-C
- [Samsung 27" M50A Full HD Smart Monitor](https://a2hmarket.ai/listings/listing_01M313KYWE8FB3V254YHWK1VB7)：27寸£40，E3
- [Samsung Curved Monitor](https://a2hmarket.ai/listings/listing_01M36472E9RTFV1XHJJGBCRNEE)：27寸£45，配转接线

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 这次搜索还没找到关键条件都能确认的供给。下面3条可作备选，先核实标出的信息。

**核对：** A找到£60、27寸且帖子宣称USB-C的候选，功能仍需实拍确认；B工具返回没有ARZOPA，转为多个未确认USB-C选项。

### G5 · 我在E14有一张宜家书桌想卖30镑，帮我找正在求购书桌的买家。

A 15/20，等级2；B 8/20，等级1。维度匹配/来源/实用/决策/阅读：A [3, 3, 2, 3, 4]，B [1, 3, 2, 1, 1]。

**A独立回答**

有一条狗岛/Canary Wharf附近明确求购二手书桌椅的需求帖，是你的对家，而不是另一位卖家。地区和物品相符，但对方未写预算，不能保证接受£30或只收桌子。可以从原帖询问“宜家书桌£30，E14自提，尺寸是…，是否仍在收”；先补尺寸和成色照片。其他更远的求购者可作备选，本次不代联系或发帖。

来源：
- [二手书桌椅](https://a2hmarket.ai/listings/listing_01M2YHE9AT8FWK5AY8ARN0MXC2)：狗岛求购桌椅，预算未写

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 这次搜索还没找到关键条件都能确认的供给。下面3条可作备选，先核实标出的信息。

**核对：** A找到狗岛求购桌椅；B优先列Old Street且其原文不考虑远处，其他地点也未匹配E14。

### H1 · E14找长租单间，2026年11月初入住，月租1200镑以内。

A 17/20，等级2；B 0/20，等级0。维度匹配/来源/实用/决策/阅读：A [3, 3, 4, 3, 4]，B [0, 0, 0, 0, 0]。

**A独立回答**

优先询问E14 UCL宿舍单间：一条标£1100–1200/月，包水电气，council tax另计，合同至2027年9月；另一条前期£900、12月中后约£1200，是过渡价格，不能把£900当长期价，也可能为同一房源的更新帖。另有E14 £830包bills长租，但写了只租女生和身份/租期限制，不适合所有人。11月初能否开始、真实当前价格、合规转租和室友共用卫浴都先确认，再约看房。

来源：
- [伦敦 E14 UCL新宿舍单间转租](https://a2hmarket.ai/listings/listing_01M3NPJ2KJ7G8279DKKR37HEJN)：E14 £1100–1200/月，长期合同
- [E14狗岛转租](https://a2hmarket.ai/listings/listing_01M3XFTDT3A1Y097K91TV76HHV)：前期£900后约£1200，不应视为两套已独立房源
- [E14 Westferry/Limehouse 女生大单人间长租 £830/月包bills](https://a2hmarket.ai/listings/listing_01M1W4NK7QSMFP8PPHHK9K63DT)：£830包bills，但租客限制明确

**B真实结果**

未回复。终点：{"reason": "duplicate_delivery", "outcome": "dropped_by_rule"}

**核对：** A区分月租/过渡价/可能重复房源/租客限制；B malformed market_search JSON导致publishApproval SyntaxError，队列重试后duplicate_delivery。

### H2 · Stratford想找允许养猫的一居室整租，月租1600镑以内，11月入住。

A 15/20，等级2；B 8/20，等级1。维度匹配/来源/实用/决策/阅读：A [2, 4, 2, 3, 4]，B [1, 3, 2, 1, 1]。

**A独立回答**

本次没找到已证实“Stratford＋独立一居室＋允许猫＋≤£1600/月＋11月入住”的房源。有Stratford复式1b1b整租，独立厨卫、近期可入住，但租金和宠物政策没写，只能作询问线索；Stratford One的Studio不能当作带独立卧室的一居室。先问总月租、猫是否获房东书面许可、11月起租及整租资格，别把“宠物未知”说成宠物友好。

来源：
- [伦敦Stratford复式loft一居室](https://a2hmarket.ai/listings/listing_01M3KG26Z97WKEEHX7J7T1SFBR)：1b1b整租，价格/猫/11月未证实

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 这次搜索还没找到关键条件都能确认的供给。下面3条可作备选，先核实标出的信息。

**核对：** 双方都没有证实允许猫/£1600/11月入住；A只列1b1b，B第一条是Studio。

### H3 · 刚到KCL读书，想找室友一起合租，Waterloo通勤30分钟内，预算每人1100镑一个月。

A 16/20，等级2；B 9/20，等级2。维度匹配/来源/实用/决策/阅读：A [3, 3, 3, 3, 4]，B [2, 3, 2, 1, 1]。

**A独立回答**

较贴近的是KCL Whitehouse 2b2b拼室友帖：原文称步行至Waterloo校区3分钟，租期44周起，但没写每人费用。还有Waterloo附近3b2b招室友，水网等条件各有差异与男生限制；不能直接称符合£1100/月。询问分摊房租、bill和council tax、具体校区及看房再选择。我排除了仅找现有同公寓朋友和预算£300/周（约£1300/月）的帖子。

来源：
- [还有人拼 KCL 步行到校2b2b 吗？](https://a2hmarket.ai/listings/listing_01M4FY7KEC037YJT57GBDV2T48)：Waterloo校区步行3分钟，月租未知
- [男生3b2b合租](https://a2hmarket.ai/listings/listing_01M3PM8BFVKKH7JQ0CZ9Z2G933)：Waterloo 3b2b招男室友，费用未知

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 这次搜索还没找到关键条件都能确认的供给。下面3条可作备选，先核实标出的信息。

**核对：** 双方均有Whitehouse近Waterloo线索但预算未知；A优先，B排第二且把通勤放进路线待确认。

### C1 · 找2026年11月上海飞伦敦的帮带，想带2公斤衣服。

A 16/20，等级2；B 7/20，等级1。维度匹配/来源/实用/决策/阅读：A [2, 4, 3, 3, 4]，B [1, 2, 2, 1, 1]。

**A独立回答**

最接近的是往返帮带帖原文“11.04上海飞伦敦”；没有明确年份，而且实际可用状态要核实，因此只能算候选。2kg衣服的剩余行李额、按公斤还是总价、上海收件和伦敦交接地点都没确认。10月上海飞伦敦、11月伦敦飞上海都不满足这次请求，我未列作推荐。建议先问是否指2026年11月4日且仍有2kg；未确认前不要付钱或寄件。

来源：
- [布里斯托往返帮带服务](https://a2hmarket.ai/listings/listing_01M3XHMVD28MS633DE4DK8FH27)：原文11.04上海→伦敦；年份/2kg未知

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 这次搜索还没找到关键条件都能确认的供给。下面2条可作备选，先核实标出的信息。

**核对：** A保留11.04上海→伦敦，年份/2kg需问；B把10月17日供给也作为11月候选。

### C2 · 我2026年11月1日伦敦飞上海，有2公斤空余行李，帮我找需要帮带的人。

A 14/20，等级2；B 3/20，等级0。维度匹配/来源/实用/决策/阅读：A [2, 3, 2, 3, 4]，B [0, 1, 1, 0, 1]。

**A独立回答**

有一个公开求帮带帖明确需要“伦敦到上海”的人肉行李帮带，与供给方向相符，但没写日期和重量，不能确认适合你11月1日的2kg。可从原帖先询问物品类型、重量、伦敦交接和上海接收方式。需要20kg整箱、10月宠物或12月航班的帖子都不适合这次。我不会把其他同行提供者当成你要找的需求方。

来源：
- [有偿！！伦敦到上海带行李！！联系我！！](https://a2hmarket.ai/listings/listing_01M3K0DVM9YHVCK75MR8ES1EAQ)：伦敦→上海需求，日期/物品/重量未写

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 这次搜索还没找到关键条件都能确认的供给。下面1条可作备选，先核实标出的信息。

**核对：** A查BUY需求方；B确定性marketTarget=SELL覆盖模型BUY查询，推荐11月8日另一供给方，角色和日期都不符。

### P1 · E14想找周末羽毛球搭子，我是初学者，有适合新手的吗？

A 13/20，等级1；B 7/20，等级1。维度匹配/来源/实用/决策/阅读：A [1, 4, 2, 2, 4]，B [1, 3, 1, 1, 1]。

**A独立回答**

本次没找到已确认同时满足E14、周末、初学者友好的约球。一个伦敦羽毛球搭子帖只写有空可约，地区/时间/水平未知，可先问；UCL帖子“新生老手都有”不能证明初学者可参加。我排除了明确非新手、exclude beginners和建议中阶以上的局。可以问候选能否在E14周末打休闲新手局，接受较远球场时再扩到别区。

来源：
- [#伦敦 #羽毛球 #搭子 #羽毛球搭子](https://a2hmarket.ai/listings/listing_01M4GB8B20M6PZV45BTYFJEHMH)：真正约球，但地点/水平/周末未写
- [UCL 26fall找打球搭子](https://a2hmarket.ai/listings/listing_01M3S6R9FW58CTF94DQ4GGMJN9)：新生不等于羽毛球初学者

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 这次搜索还没找到关键条件都能确认的供给。下面3条可作备选，先核实标出的信息。

**核对：** 没有确证E14周末初学者局；A排除非新手/中阶局并给问法；B多为标签和新生等不等于初学者的信息。

### P2 · 10月17日想在Greenwich散步两小时，找个一起走走聊天的搭子。

A 15/20，等级2；B 9/20，等级2。维度匹配/来源/实用/决策/阅读：A [3, 3, 2, 3, 4]，B [2, 3, 2, 1, 1]。

**A独立回答**

有一条明确在Greenwich找一起走走的同行者，地点和散步需求相符，但没有10月17日和两小时的承诺。优先从原帖问当天是否有空、在哪集合、是否只散步聊天；另一条伦敦散步搭子接受白天或晚上，可作地区待确认备选。不要把普通Greenwich游记当成已经有人愿意同行。

来源：
- [倫敦找搭子](https://a2hmarket.ai/listings/listing_01M4D2YQTWFKZ16R86MQE0K6CC)：Greenwich真实散步招募
- [伦敦招散步搭子](https://a2hmarket.ai/listings/listing_01M3709JHPVYFA1NFQQR91MF2W)：伦敦散步招募，时间弹性

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 这次搜索还没找到关键条件都能确认的供给。下面3条可作备选，先核实标出的信息。

**核对：** A先Greenwich真实散步招募；B先广义散步/塔桥，将Greenwich排第三。双方日期/时长未确证。

### P3 · 想在伦敦找英语口语练习搭子，工作日晚上，Soho附近最好。

A 14/20，等级2；B 6/20，等级1。维度匹配/来源/实用/决策/阅读：A [2, 3, 2, 3, 4]，B [1, 2, 1, 1, 1]。

**A独立回答**

A2H里有伦敦市中心明确想练中文的交换需求，但对方说以往总变成英文、希望多聊中文；你需与其商定中英各半，不能默认是纯英语练习搭子。其Soho具体地点和工作日晚间未写。一个“Online Language Exchange”帖同样是中文母语者找英语母语者，与你诉求同侧，不是合适的英语供给。我也排除了2027年才来伦敦的帖子。

来源：
- [想练中文，不是英文哈哈 😂](https://a2hmarket.ai/listings/listing_01M42ZTYGXHD9DMFN1AYZYKSZE)：中文练习需求，可协商中英各半；时间未知

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 这次搜索还没找到关键条件都能确认的供给。下面3条可作备选，先核实标出的信息。

**核对：** A识别练中文者可协商互换；B多列提供中文而需要英语的同侧需求，Soho/晚间未匹配。

### L1 · 伦敦这个月有什么值得看的展？帮我按艺术、摄影、沉浸式分一分。

A 19/20，等级3；B 0/20，等级0。维度匹配/来源/实用/决策/阅读：A [4, 4, 3, 4, 4]，B [0, 0, 0, 0, 0]。

**A独立回答**

按2026年10月的开放日期，我会这样选：绘画看National Gallery的Renoir and Love（10月3日–2027年1月31日），主题是爱、友谊与人物生活，特展收费；摄影看National Portrait Gallery的Tim Walker’s Fairyland（10月9日–2027年2月7日），适合喜欢故事感和幻想视觉的人；沉浸式看Lightroom的Larger Than Life（10月14日起），用大幅投影呈现Aardman动画与制作过程，适合轻松体验。三个都按“展”介绍，不把多篇帖子拆成多个展。各场具体票价和时段从以下官网订位页面确认。

来源：
- [Renoir官方展讯](https://www.nationalgallery.org.uk/about-us/press-and-media/press-releases-archive/renoir-and-love)：展名/主题/日期/收费
- [Tim Walker官方展览](https://www.npg.org.uk/whatson/exhibitions/2026/tim-walkers-fairyland-love-and-legends)：摄影展与日期
- [Lightroom官方FAQs](https://lightroom.uk/faqs/)：Larger Than Life从2026-10-14开放、节目介绍和订票

**B真实结果**

未回复。终点：{"outcome": "agent_completed", "toolsCalled": ["xhs_search", "xhs_search", "xhs_search", "do_nothing"]}

**核对：** A按展览实体分类并官网核对2026-10开放；B小红书空列表后主动不回。

### L2 · 2026年10月17到18日伦敦有什么免费活动，白天可以去的？

A 19/20，等级4；B 0/20，等级0。维度匹配/来源/实用/决策/阅读：A [4, 4, 4, 3, 4]，B [0, 0, 0, 0, 0]。

**A独立回答**

10月17–18日白天优先去Regent’s Park的Frieze Sculpture：官方列2026年9月16日–11月1日、免费户外雕塑，适合走走看装置，天气好再去。雨天备选National Maritime Museum或Queen’s House免费常设参观，官网列每日10–17点，建议预约；这是免费场馆参观，不是另一个已核实周末专场。收费Frieze London艺博会没有算进免费选项。

来源：
- [Frieze Sculpture官方](https://www.frieze.com/fairs/frieze-sculpture)：指定日期覆盖/免费户外
- [Royal Museums Greenwich](https://www.rmg.co.uk/national-maritime-museum)：每日10–17点/免费与预约

**B真实结果**

未回复。终点：{"outcome": "agent_completed", "toolsCalled": ["xhs_search", "xhs_search", "do_nothing"]}

**核对：** A Frieze Sculpture免费日期覆盖，雨天免费常设备选；B空列表后不回。

### L3 · 四个人想在伦敦唐人街吃火锅，人均30镑左右，有什么推荐？

A 15/20，等级2；B 0/20，等级0。维度匹配/来源/实用/决策/阅读：A [3, 3, 2, 3, 4]，B [0, 0, 0, 0, 0]。

**A独立回答**

四个人、£30左右我会先比较Little Lamb和Shu Xiang Ge：前者在72 Shaftesbury Avenue，蒙古风味共锅、套餐更容易控制总预算；后者10 Gerrard Street，偏麻辣四川火锅。唐人街官网支持地点和风格，但Little Lamb页面价格介绍年代较早，我没有把旧套餐价当作2026现价。订四人位时核对人均是否含锅底、饮料和服务费，并把总餐费目标设£120。按辣度选，不先承诺两家都能£30吃饱。

来源：
- [Little Lamb](https://chinatown.co.uk/en/restaurant/little-lamb/)：地点/营业/共享火锅，旧价不当现价
- [Chinatown火锅指南](https://chinatown.co.uk/en/features/hot-pot/)：Shu Xiang Ge地点与风格

**B真实结果**

未回复。终点：{"outcome": "agent_completed", "toolsCalled": ["find_suppliers", "web_search", "reply_with_search_results"]}

**核对：** A地点/风味/四人总预算目标、旧价格不当现价；B web已搜但出站worthReplying0.02拒绝，未更新旧other帮带需求。

### L4 · Liverpool Street附近想吃早茶点心，人均25镑左右，推荐两三家。

A 16/20，等级2；B 0/20，等级0。维度匹配/来源/实用/决策/阅读：A [3, 3, 3, 3, 4]，B [0, 0, 0, 0, 0]。

**A独立回答**

最近的正式点心选择是Broadgate的Yauatcha City，有全天点心和午餐菜单，但当前£25内完整早茶餐没有确认，别沿用网上11年前的£25套餐。想便宜、快速吃几样，Liverpool Street的Three Uncles官方菜单有dim sum，不过主要是烧腊快餐，不是完整茶楼体验。先看两家当前菜单，再比较单点几份的总价；没有再塞一家远处餐厅凑成三家。

来源：
- [Yauatcha City](https://hakkasangroup.com/venues/yauatcha-city-london/)：Broadgate点心餐厅/当前菜单入口
- [Three Uncles Liverpool Street](https://www.threeuncles.co.uk/liverpool-street-1)：该店官方菜单有dim sum，体验不同

**B真实结果**

未回复。终点：{"outcome": "agent_completed", "toolsCalled": ["find_suppliers", "web_search", "reply_with_search_results"]}

**核对：** A两种附近点心选择，区分茶楼与快餐、预算未知；B web搜索后出站0.02拒绝，未建档本轮需求。

### L5 · 伦敦周末下雨，想带5岁小朋友去室内玩，免费或每人15镑以内。

A 20/20，等级4；B 0/20，等级0。维度匹配/来源/实用/决策/阅读：A [4, 4, 4, 4, 4]，B [0, 0, 0, 0, 0]。

**A独立回答**

我会优先选Greenwich海事博物馆AHOY!儿童区：为0–7岁设计，室内角色扮演，周末£5/儿童，含一位陪同成人，45分钟一场，提前订时段；博物馆本身免费。另一个预算友好选择是South Kensington的Science Museum，普通入场免费，10–18点，先预约免费票；Wonderlab等专区要另外买票，不能把它们全算免费。5岁想主要玩选AHOY，想看交通/太空展品选Science Museum。

来源：
- [AHOY官方](https://www.rmg.co.uk/national-maritime-museum/attractions/ahoy-childrens-gallery)：0–7岁/周末£5/成人包含/45分钟
- [Science Museum Visit](https://www.sciencemuseum.org.uk/visit)：免费普通入场/预约/开放时间

**B真实结果**

未回复。终点：{"outcome": "agent_completed", "toolsCalled": ["find_suppliers", "web_search", "web_search", "reply_with_search_results"]}

**核对：** A AHOY 0–7岁周末£5含成人45分钟+科学馆免费入场；B web搜索后出站0.01拒绝。

### S1 · 10月24日从E14搬到SE1，8箱加一张书桌，预算120镑，想找能中文沟通的man and van。

A 16/20，等级2；B 13/20，等级2。维度匹配/来源/实用/决策/阅读：A [3, 3, 3, 3, 4]，B [2, 3, 3, 2, 3]。

**A独立回答**

中文是你的明确需求，我会先询价提供中文搬家服务的家家速递，而不是仅凭公司在伦敦就说司机能讲中文。CF Student Move也提供中文客服，可问是否承接E14→SE1；页面£60是起价，不能拿来当你这条伦敦路线的报价。把10月24日、8箱、书桌尺寸、楼层/电梯、停车条件发给两家，要求£120含全部费用的书面报价，并区分中文客服和现场中文司机。本次没有确认两家档期或总价。

来源：
- [家家速递搬家](https://www.jiajiaexpress.co.uk/page-46265.html)：自述中文搬家服务
- [CF Student Move](https://student.courierfly.co.uk/)：中文客服、英国服务；起价适用城市不同

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 10月24日 E14 到 SE1，8箱加一张书桌这个量不大，我找到三家周末也做的：The London Man And Van（1

**核对：** A找到明确中文服务并要求完整路线报价；B三家便于联系但中文未核实，按小时推预算。

### S2 · 10月31日E14一居室退租清洁，需要invoice，预算180镑，有推荐吗？

A 13/20，等级1；B 15/20，等级2。维度匹配/来源/实用/决策/阅读：A [1, 3, 3, 2, 4]，B [3, 3, 3, 3, 3]。

**A独立回答**

两家公开提供Canary Wharf/Tower Hamlets退租清洁的服务可先问，但你的£180目前没确认足够：Samyx的E14一居室页面列£198起，End of Tenancy LTD一居室£207；它们不是£156起价对应的一居室。若预算不动，询问一居室能否£180固定报价，包含厨房/烤箱、是否VAT另加、能否开invoice及10月31日档期。也问检查不合格重清的范围，不把“起价”说成你的最终费用。

来源：
- [Samyx E14](https://samyxcleaning.com/end-of-tenancy-cleaning/canary-wharf-e14/)：E14一居室£198起，搜索摘要可读
- [End of Tenancy LTD Tower Hamlets](https://endoftenancy.com/cleaning-tower-hamlets)：1bed £207，报价按房况

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> 10月31日 E14 一居室退租清洁，这三家周末都做：Good Old Clean（1-bed £180，[联系方式已隐藏] / 

**核对：** B固定商家库找到£180一居室参考价，官网其他伦敦区支持该指导价，invoice/档期仍需问；A只找到超预算候选且初稿一条网址写错，保留扣分。

### S3 · SE16想找人安装IKEA PAX衣柜，预算100镑，有推荐吗？

A 16/20，等级2；B 15/20，等级2。维度匹配/来源/实用/决策/阅读：A [2, 4, 3, 3, 4]，B [3, 3, 3, 3, 3]。

**A独立回答**

优先用IKEA官方对接的Taskrabbit家具安装入口，为PAX具体组合生成报价。IKEA公布家具安装£33起，但不代表你的整套PAX只要£33或一定能£100以内。准备柜体数量、宽高深、门型、是否需要拆旧柜、墙面固定和SE16位置，再看当地安装者的固定报价/评价。若顶天立地或滑门复杂，要求写清固定、搬运及清包装是否包含；确认后由你预订。

来源：
- [IKEA官方安装](https://www.ikea.com/gb/en/customer-service/services/assembly/)：官方Taskrabbit入口
- [IKEA安装费用说明](https://www.ikea.com/gb/en/customer-service/knowledge/articles/de5f5394-1g56-443c-9eg7-7588bd44df78.html)：£33起不等于完整PAX价

**B真实结果**

已发送，完整脱敏正文见[b-answers.json](../../scripts/poc/p21-london-ab/b-answers.json)。

> SE16 装 IKEA PAX 衣柜，我名单里合适的这两家：The Italian Tasker（£65 起，把照片或 IKEA 

**核对：** A官方Taskrabbit流程更稳但未筛到具体人；B两位具体PAX安装商且£65起有官网支持，£100够的判断未确证；两者差1分算平。

### A1 · 刚搬到SE1，附近有能买豆腐、火锅底料和青菜的中国超市吗？想线下买。

A 16/20，等级3；B 0/20，等级0。维度匹配/来源/实用/决策/阅读：A [3, 3, 3, 3, 4]，B [0, 0, 0, 0, 0]。

**A独立回答**

SE1先看Tian Tian Market South Bank，位于Southbank Central/Stamford Street，有中国及亚洲杂货，适合线下采购。地区官网列周一至周四和周日11–21点，周五六11–21:30；分店官网也列South Bank。豆腐、青菜的当天库存及你想要的火锅底料品牌没法在线保证，去前问该店或查看门店入口。我没把W3 North Acton分店地址误配给South Bank。

来源：
- [South Bank官方地区目录](https://southbank.london/see-and-do/tian-tian-market)：该店具体位置/营业/亚洲杂货
- [Tian Tian官方分店](https://www.tiantian.london/find-us)：South Bank分店存在

**B真实结果**

未回复。终点：{"outcome": "agent_completed", "toolsCalled": ["web_search", "reply_with_search_results"]}

**核对：** A South Bank官方店位置/营业/亚洲杂货，具体库存未保证；B有web结果但出站0.24拒绝，旧other帮带需求仍存在。

### A2 · 刚到伦敦住E14，还没有NHS number，怎么注册GP？需要带什么，附近哪里能注册？

A 20/20，等级4；B 0/20，等级0。维度匹配/来源/实用/决策/阅读：A [4, 4, 4, 4, 4]，B [0, 0, 0, 0, 0]。

**A独立回答**

没有NHS number也能注册英格兰GP，注册免费；NHS说明不以提供ID、住址证明或移民身份证明作为必须条件，已有资料可带上，但别等拿到NHS号才申请。用NHS Find a GP输入完整E14邮编，选接受你区域且开放注册的诊所，填在线表或向诊所取纸表；一般收到资料后约5天，但可能更久。E14可查看GP at hand Canary Wharf入口，需核对接收范围及它以远程服务为主是否合适。没有预先替你注册，也没要求公开个人资料。

来源：
- [NHS GP注册](https://www.nhs.uk/nhs-services/gps/how-to-register-with-a-gp-surgery/)：无需NHS号/免费/步骤
- [NHS England注册政策](https://www.england.nhs.uk/long-read/primary-medical-services-policy-and-guidance-manual-pgm-2/)：ID/住址/移民文件/NHS号非必要
- [NHS找GP](https://www.nhs.uk/service-search/find-a-gp/)：按完整邮编确认辖区
- [Canary Wharf GP at hand](https://www.gpathand.nhs.uk/our-clinics/canarygp/)：E14注册候选，不保证适合个人

**B真实结果**

未回复。终点：{"outcome": "agent_completed", "toolsCalled": ["do_nothing"]}

**核对：** A NHS官方无需NHS号/证件强制与实际注册入口；B明确以超出支持范围do_nothing。

### A3 · 住E14，10月17日早上8点希思罗T2的航班，两件大行李，怎么去机场合适？

A 17/20，等级3；B 0/20，等级0。维度匹配/来源/实用/决策/阅读：A [3, 4, 3, 3, 4]，B [0, 0, 0, 0, 0]。

**A独立回答**

8点航班、两件大行李，我会优先比较预订机场车与夜间公共交通。Heathrow建议长途国际提前3小时到（目标5点）、英国/欧洲航班提前2小时（目标6点），先确认你的航线及航空公司托运截止。普通Elizabeth line日间能从Canary Wharf到T2/3且无障碍，但我没核到10月17日首班能达到上述目标，不能直接推荐“坐首班就够”。在TfL按10月17日、目标到达时刻查夜间路线/工程，再和到T2的车辆固定报价比较；车辆出发时间需按实际上车地址/路况倒推。

来源：
- [Heathrow报到时间](https://www.heathrow.com/departures/checking-in)：长途3h、英国欧洲2h
- [TfL Heathrow Elizabeth line](https://tfl.gov.uk/modes/elizabeth-line/getting-to-and-from-heathrow-on-the-elizabeth-line)：T2/3与无障碍，不保证指定首班
- [TfL Journey Planner](https://tfl.gov.uk/plan-a-journey/)：需要按指定日期/到达时间确认

**B真实结果**

未回复。终点：{"outcome": "agent_completed", "toolsCalled": ["do_nothing", "find_suppliers"]}

**核对：** A航线长短到达时间、行李、车辆/夜间路线与首班核对；B将机场交通咨询当不支持而do_nothing。

## 记录入口

- [固定24题/验收](../../scripts/poc/p21-london-ab/cases.json)
- [A回答/来源](../../scripts/poc/p21-london-ab/a-answers.json)
- [B脱敏回答/终点/耗时](../../scripts/poc/p21-london-ab/b-answers.json)
- [逐例评分](../../scripts/poc/p21-london-ab/scores.json)
- [诊断/方法限制](../../scripts/poc/p21-london-ab/diagnostics.json)

只读脚本search-market.mts、search-xhs.mts、collect-telegram.mts。原始公开搜索暂存/tmp/p21-a-market.json、/tmp/p21-a-xhs.json，未导出用户身份、完整session或密钥。采集脚本未向业务表写入，B写库由真实机器人完成。
