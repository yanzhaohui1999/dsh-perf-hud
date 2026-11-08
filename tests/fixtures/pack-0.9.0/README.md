# 这份诊断包里有什么

manifest.json 是入口(格式版本、平台、采集档位、能力矩阵、脱敏说明);summary.md 是给人读的摘要;incident.json 是结构化原始证据;README.md 就是你正在读的这份。
先读 summary.md 的「最可能的假设」:每一条都带支持证据与限制,以及出处(直接测量 / 归因推断 / 无法确认)。「缺失的证据」说明这一层为什么没采到 —— 不要把「没有证据」读成「没有发生」。
包内不含聊天正文、提示词、Cookie、Token 与请求头(不是筛掉了,是本来就没采);页面地址只保留 origin + path,用户目录降级成 ~,UA 只留主版本与系统。这是减法,不是匿名化。
在别的工具里读 incident.json 时:帧的 t 是页面时间轴毫秒,要靠 incident.env.perfOrigin 换成墙钟;loaf 与 frames 是同一信号的两个视图,别相加;blocking 可以是 0 而这一帧仍然很重。
