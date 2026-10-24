/**
 * dsh-perf-hud 的包内分片(package-local chunk):面板渲染层。
 *
 * 由 `apply()` 的 `PerfHudGate` 在渲染前 `require.async` 到位 —— 渲染层用到的一批
 * 主文件函数通过 `createUi(deps)` 显式传入(闭包依赖不反向 import)。
 */
window.__ModuleLoader__.load({
	id: 'dsh-perf-hud',
	chunk: 'client.ui.js',
	factory: (require) => {
		const exports = {};
		exports.createUi = (deps) => {
			const {
				detailGroupLabel,
				EVIDENCE_MAX,
				LS_UI,
				MONO_FONT,
				panelWidthFor,
				pillCompact,
				// 拖动 / 位置记忆:纯函数与落盘都在主文件那侧(与 panelWidthFor 同一套来源)
				hudPosClamp,
				hudPosMake,
				hudPosMaxHeight,
				HUD_POS_MIN_ROOM,
				HUD_POS_PILL_ROOM,
				saveHudPos,
				PICK_MIN_MS,
				REPLAY_COLS,
				ROOT_ID,
				React,
				S,
				SPARK_COLORS,
				SPARK_MAX_MS,
				SPARK_REPLAY_HEIGHT,
				TALLY_BUCKET_MS,
				TALLY_MINUTES,
				TALLY_TREND_LONG_MS,
				TALLY_TREND_SHORT_MS,
				TARGETS,
				TOP_N,
				W,
				anyGroupOpen,
				attrText,
				barSegments,
				blame,
				bump,
				bytesText,
				storageReport,
				causeCandidates,
				causePlainLead,
				clearIncidentsNow,
				clock,
				collapseAll,
				copyText,
				crossSummary,
				crossTable,
				detailContext,
				detailSummary,
				diagMode,
				displayKey,
				domSummary,
				eventEvidenceText,
				eventValueText,
				eventVerdictText,
				eventWindowText,
				evidenceFooter,
				evidenceFooterTitle,
				evidenceLine,
				evidenceGroupLine,
				evidenceName,
				evidenceScope,
				evidenceWhereText,
				evidenceZeroText,
				exportIncident,
				exportJson,
				exportPack,
				frame,
				frameArcs,
				frameMixNow,
				frameMixCountText,
				frameMixRows,
				frameRing,
				group,
				h,
				healthIcon,
				healthText,
				healthVerdict,
				heapRateText,
				hitText,
				hostEventsText,
				hostFreshness,
				hostLoopStateText,
				hostSummary,
				hudDodge,
				incidentFrameHeadingText,
				incidentFrameStep,
				incidentLongTasksAt,
				incidentSummaryText,
				incidentVerdict,
				incidentWallClock,
				infraVerdict,
				jsBreakdownText,
				lastStallSubText,
				latestIncident,
				layoutDirty,
				levelFrame,
				levelUp,
				linkRowText,
				linkStats,
				liveFrameHeadingText,
				longTaskTally,
				mb,
				msPerSecText,
				natives,
				overviewLine1,
				overviewLine2,
				overviewTitle,
				packPreview,
				pickAuto,
				pickList,
				pickStep,
				pickedLoaf,
				pluginTable,
				provenanceText,
				push,
				rateText,
				recordError,
				recorderText,
				renderErrorView,
				HudBoundary,
				replayCellTitle,
				replayColumns,
				replayScope,
				replaySummaryText,
				replayX,
				resetLayout,
				restTitleText,
				restValueText,
				revealIncident,
				ring,
				sceneChip,
				secondsText,
				selectIncident,
				selectIncidentFrame,
				selectedIncident,
				setCauseOpen,
				setDeep,
				setDevTab,
				setEnabled,
				setIncidentScope,
				setOnlyBad,
				shellSummary,
				longTaskLabel,
				evidenceLocatable,
				crossSingleText,
				setTrendMs,
				setView,
				severityColor,
				severityLevel,
				severityText,
				short,
				showLiveMode,
				sparkStrip,
				splitLegend,
				state,
				strengthText,
				suspectLink,
				tallyTitle,
				tallyWindow,
				techSummary,
				toolsSummary,
				translate,
				trendRawText,
				trendSummary,
				trendText,
				unattrText,
				unexplainedFrame,
				verdictColor,
				watchFlagText,
				watchPanelText,
				watchRowText,
				watchSelectedText,
				whoRows,
				windowScopeText,
				worstLongTask,
				worstSecond,
				worstSecondText,
				writeRows
			} = deps;

		/**
		 * 标题栏图标。**行内 SVG,不引任何图标库**:面板只依赖 React 与自身分片,
		 * 多加一个包就多一份"插件加载失败"的面。
		 *
		 * knobs(设置的三条滑杆)用 `bg-overlay` 填色,和小圆点背后的面板底色一致 ——
		 * 换成白色小圆点会像"进度条上的三个点"。
		 */
		const ICONS = {
			sliders: [
				['path', { d: 'M2.5 5h11' }], ['path', { d: 'M2.5 8h11' }], ['path', { d: 'M2.5 11h11' }],
				['circle', { cx: 5.5, cy: 5, r: 1.6, fill: 'var(--dsw-alias-bg-overlay)' }],
				['circle', { cx: 10.5, cy: 8, r: 1.6, fill: 'var(--dsw-alias-bg-overlay)' }],
				['circle', { cx: 5.5, cy: 11, r: 1.6, fill: 'var(--dsw-alias-bg-overlay)' }],
			],
			minus: [['path', { d: 'M3.5 8h9' }]],
			plus: [['path', { d: 'M8 3.5v9M3.5 8h9' }]],
			close: [['path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }]],
			back: [['path', { d: 'M9.5 3.5L5 8l4.5 4.5' }]],
			prev: [['path', { d: 'M9.5 3.5L5 8l4.5 4.5' }]],
			next: [['path', { d: 'M6.5 3.5L11 8l-4.5 4.5' }]],
			copy: [['rect', { x: 5.5, y: 5.5, width: 7, height: 7, rx: 1.4 }], ['path', { d: 'M10.5 3.5h-6a1 1 0 00-1 1v6' }]],
			download: [['path', { d: 'M8 2.5v7M5 6.8L8 9.8l3-3M3 11.5v1.2h10v-1.2' }]],
			chev: [['path', { d: 'M6 3.5l4.5 4.5L6 12.5' }]],
		};
		function panelIcon(name, size) {
			const spec = ICONS[name] ?? [];
			return h('svg', {
				viewBox: '0 0 16 16', width: size ?? 14, height: size ?? 14, 'aria-hidden': 'true',
				fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
				style: { display: 'block', pointerEvents: 'none' },
			}, spec.map((item, index) => h(item[0], { key: index, ...item[1] })));
		}

		/**
		 * 自测用的重组件:一次提交塞进 count 个节点,制造真实的渲染型 longtask。
		 *
		 * ⚠️ 这个声明曾被"排版改造"整段替换时吞掉过一次:文件里 h(PerfHudStress, …) 还在、
		 * 定义没了 → React 抛 "Element type is invalid" → 外壳的 SlotErrorBoundary 把
		 * 整个槽位条目停用(面板凭空消失)。现在 tests/logic.mjs 有静态检查钉住这类引用。
		 */
		function PerfHudStress(props) {
			const started = performance.now();
			// 显式燃烧:自测要的是"确定地让这次渲染超过 50ms",好自检归因链路;
			// 真实卡顿不需要它(自然卡顿由流式渲染/布局产生)。面板上标注"含人为燃烧"。
			const burnUntil = performance.now() + (typeof state.stressBurn === 'number' ? state.stressBurn : 0);
			while (performance.now() < burnUntil) { /* 自测专用同步燃烧 */ }
			const items = [];
			for (let i = 0; i < props.count; i += 1) items.push(h('span', { key: i }, '.'));
			// 这次提交一结束就:① 清空标记(否则面板每 0.5 秒重渲染都会再造两万个节点)
			// ② 记下"渲染→提交"的墙钟耗时 —— 不依赖 longtask,切片提交也能给出真实数字。
			React.useEffect(() => {
				state.stressNodes = 0;
				if (state.stress !== null && state.stress.commitMs === undefined) {
					state.stress.commitMs = Math.round((performance.now() - started) * 10) / 10;
				}
			}, []);
			return h('div', {
				// 读 offsetHeight = 在当前任务里强制布局。实测:不强制时浏览器可以把布局推迟到下一帧,
				// 任务里只剩 React 提交那十几毫秒 → 根本凑不出 >50ms 的长任务(自测时有时无就是这个)。
				ref: (element) => { if (element !== null) void element.offsetHeight; },
				style: { position: 'fixed', left: -9999, top: 0, width: 1, height: 1, overflow: 'hidden' },
			}, items);
		}
		/**
		 * 主界面:普通用户的那一屏,只回答五个问题。
		 * 它**只排版**——四个读数(`healthVerdict` / `selectedIncident` / `causeCandidates` /
		 * `trendSummary`)全是已经算好的纯函数,界面自己不推断(与"口径只在纯函数里"同一条规矩)。
		 * ⚠️ 这里**不出现** LoAF / p99 / RTT / 包名排行 / 帧编号 —— 那些在「开发者详情」。
		 */
		function mainView(props) {
			const t = translate;
			const health = props.health;
			// ⚠️ 这里是**时间语义**(最近一次);严重度语义(最差那条)只属于开发者详情。
			const row = props.latest ?? null;
			const causes = row === null ? [] : causeCandidates(row);
			// ⚠️ 必须是**局部名字**:这个函数在模块作用域,直接写 `trendMs` 会去解析全局标识符 ——
			// 浏览器里当场 ReferenceError(面板整块被外壳停用),而 node --check 与三套件都看不出来。
			const trendMs = props.trendMs;
			const trendRaw = trendRawText(trendMs);
			// 60 秒帧分布:守夜只收 ≥100ms 的事故,"每帧 50ms 的 20fps 段"一条都不会触发。
			const mix = frameMixNow();
			const mixRows = frameMixRows(mix);
			const kids = [];

			// ① 当前帧率:这一屏唯一的大数。状态词退到它下面,而且**只在不是 ok 时**出现 ——
			//    "健康"两个字只是把绿颜色再说一遍。
			kids.push(h('div', { style: S.heroBlock, title: health.reason === '' ? t('healthHint') : health.reason },
				h('div', { style: { ...S.heroNum, color: levelFrame(state.fps, state.frameWorst) } },
					state.fps.toFixed(1), h('span', { style: S.heroUnit }, 'fps')),
				health.level === 'ok' ? null : h('div', { style: S.heroState },
					`${healthIcon(health.level)} ${healthText(health.level)}${health.reason === '' ? '' : ` · ${health.reason}`}`)));

			// ② 60 秒帧条(一格一秒;点得动 —— 只有真能跳到那一格的长帧才给手型)。
			kids.push(h('div', { style: S.stripWrap, title: t('sparkHint') }, sparkStrip()));

			// ③ 帧分布:帧条的合计。占比在前、档位与条数在后,六格两行 —— 不再是一条 44 字的长串。
			kids.push(mix === null
				? h('div', { style: S.mixEmpty }, t('frameMixEmpty'))
				: h('div', { style: S.mixGrid, title: t('frameMixHint') },
					mixRows.map((item) => h('div', { key: item.label, style: S.mixCell },
						h('b', { style: S.mixPct }, item.pctText),
						h('span', { style: S.mixLabel }, `${item.label} · ${item.countText}`)))));

			// ④ 最近一次卡顿:主角是"多久";原因缩进挂在它下面 —— 从属关系由位置表达,
			//    不再写「最近一次卡顿 / 可能原因」两个眉标。
			if (row === null) {
				kids.push(h('div', { style: S.emptyRow }, t('noStallYet')));
			} else {
				const level = severityLevel(row.severity);
				const color = severityColor(level);
				kids.push(h('div', {
					style: { ...S.incBlock, borderLeftColor: color },
					title: t('viewThisStall'),
					// 验收钩子:整块可点进卡顿详情(2026-10-24 起不再有「查看这次卡顿」按钮)
					'data-incident-open': '1',
					onClick: () => props.onOpen(row.id),
				},
					h('div', { style: S.incMain },
						h('span', { style: { ...S.incDur, color } },
							String(Math.round(row.severity)), h('span', { style: S.incUnit }, 'ms')),
						h('span', { style: { ...S.incSev, color } }, severityText(level)),
						h('span', { style: S.incMeta }, lastStallSubText(row)),
						h('button', {
							type: 'button', className: 'picon', style: S.iconBtnSmall,
							title: t('causeWhyHint'),
							'aria-label': props.why === true ? t('causeWhyHide') : t('causeWhy'),
							onClick: (event) => { event.stopPropagation(); props.onWhy(props.why !== true); },
						}, props.why === true ? '–' : '?'),
						h('button', {
							type: 'button', className: 'picon', style: S.iconBtnSmall, title: t('exportAiHint'),
							'aria-label': t('exportReport'),
							onClick: (event) => { event.stopPropagation(); props.onExportPreview(row.id); },
						}, panelIcon('download')),
						panelIcon('chev', 12)),
					h('div', { style: S.causes },
						causes.length === 0
							? h('div', { style: S.cause }, row === null ? t('noCauseYet') : t('packNoCandidate'))
							: causes.map((item, index) => h('div', { key: `${index}-${item.kind}`, style: S.cause },
								h('span', { style: S.causeN }, String(index + 1)),
								h('span', { style: S.causeText }, causePlainLead(item)),
								h('span', { style: S.causeStrength }, strengthText(item.strength)))),
						// 原始线索(包名 / 毫秒 / 证据 / 限制)仍然够得着:一个小 ? 按钮,不占正文。
						props.why === true ? causes.map((item, index) => h('div', { key: `why-${index}`, style: { ...S.sub, marginTop: 4 } },
							h('div', { style: { ...S.sub, color: 'var(--dsw-alias-label-secondary)' } }, t('causeRawNote')),
							h('div', { style: { ...S.sub, fontFamily: MONO_FONT } }, `${item.lead}${item.name === null ? '' : ` · ${short(item.name)}`} · ${t('packProvenance')}:${provenanceText(item.provenance)}`),
							h('div', { style: S.sub }, `${t('packSupport')}:${item.basis.join(' / ')}`),
							h('div', { style: S.sub }, `${t('packLimits')}:${item.limits.join(' / ')}`))) : null,
						)));
			}
			// 分享前预览:还没生成文件,先把"包含什么 / 脱了什么 / 少了什么"摊出来
			if (props.preview !== null && props.preview !== undefined) {
				const preview = props.preview;
				kids.push(h('div', { style: S.card },
					h('div', { style: S.cardTitle }, t('previewTitle')),
					h('div', { style: S.sub }, `${t('previewFiles')}:${preview.files.map((file) => `${file.name}(${Math.max(1, Math.round(file.bytes / 1024))}KB)`).join(' · ')}`),
					h('div', { style: S.sub }, preview.notes === 'dropped' ? t('previewNotesDropped') : t('previewNotesKept')),
					h('div', { style: S.sub }, `${t('previewExcludes')}:${preview.excludes.length}${t('tallyUnit')}`),
					h('div', { style: { ...S.sub, color: 'var(--dsw-alias-label-secondary)' } }, `${t('previewZip')}${Math.max(1, Math.round(preview.zipBytes / 1024))}KB${t('previewZipHint')}`),
					h('div', { style: S.buttons },
						h('button', { type: 'button', style: S.btn, onClick: () => props.onExportGo() }, t('previewGo')),
						h('button', { type: 'button', style: S.btn, onClick: () => props.onExportCancel() }, t('previewCancel')))));
			}
			// ⑤ 最近趋势:次数 / 最长一次 / 重复线索。窗口切换改成两格分段控件,
			//    原来是"→ 最近 24 小时"这种带箭头的文字按钮(它把"当前"和"目标"写在同一个位置上)。
			kids.push(h('div', { style: S.trendRow, title: t('trendScope') },
				h('span', { style: S.trendText }, trendText(trendMs)),
				h('div', { style: S.seg },
					h('button', {
						type: 'button', style: { ...S.segItem, ...(trendMs !== TALLY_TREND_LONG_MS ? S.segOn : null) },
						title: t('mainTrend1'), onClick: () => props.onRange(TALLY_TREND_SHORT_MS),
					}, t('mainTrend1')),
					h('button', {
						type: 'button', style: { ...S.segItem, ...(trendMs === TALLY_TREND_LONG_MS ? S.segOn : null) },
						title: t('mainTrend24'), onClick: () => props.onRange(TALLY_TREND_LONG_MS),
					}, t('mainTrend24')))));
			if (props.why === true && trendRaw !== null) {
				kids.push(h('div', { style: { ...S.sub, fontFamily: MONO_FONT } }, trendRaw));
			}
			// 入口:只留一个 —— 「设置」在标题栏里常驻(每个视图都在),主界面再放一个就是同一个动作。
			kids.push(h('div', { style: S.linkRow },
				h('button', { type: 'button', style: S.linkBtn, title: t('devEntryHint'), onClick: () => props.onDev() },
					t('devEntry'), panelIcon('chev', 11))));
			return kids;
		}
		/**
		 * 开发者详情的标签页行:一次看一组,不把技术数据全铺在一屏(能力一个都没删)。
		 * 尾部跟着「深录」—— 它是插桩开关(有代价、默认关),只属于这一屏与设置页。**它不放在
		 * 标题栏里**:那一行是不可换行的工具条(见 S.head 的说明),而它是唯一"只在某一屏出现"的
		 * 控件 —— 实测把这一屏的标题挤到 21px(≈1.5 字)。这一行本来就换行(五个标签页本来就两行),
		 * 多它一个不增高。
		 */
		function devTabRow(props) {
			const t = translate;
			const tab = props.tab;
			// 文字页签:原来六个描边按钮(五个页签 + 深录)会折成两行,把正文挤下去;
			// 现在页签只占一行,「深录」退到右侧当一个开关位(它是开关,不是一屏)。
			const item = (key, label, hint) => h('button', {
				type: 'button', className: 'ptab',
				style: { ...S.tab, ...(tab === key ? S.tabOn : null) },
				title: hint, 'aria-selected': tab === key, role: 'tab',
				onClick: () => props.onTab(key),
			}, label);
			return h('div', { style: S.tabs, role: 'tablist' },
				item('frames', t('devTabFrames'), t('devTabFramesHint')),
				item('dom', t('devTabDom'), t('devTabDomHint')),
				item('host', t('devTabHost'), t('devTabHostHint')),
				item('tools', t('devTabTools'), t('devTabToolsHint')),
				item('raw', t('devTabRaw'), t('devTabRawHint')),
				h('button', {
					type: 'button', style: S.deepSwitch, title: t('deepHint'),
					'aria-pressed': state.deep === true,
					onClick: () => setDeep(state.deep === false),
				},
					h('span', { style: { ...S.deepDot, ...(state.deep ? S.deepDotOn : null) } }),
					t('deepShort')));
		}
		/**
		 * 设置:记录模式 / 数据保留 / 隐私与脱敏。
		 * 三个开关都是**已有**的(`state.deep` / `state.on` / `clearIncidents()`),这里不新增任何
		 * 采集行为 —— 尤其是深录:**不许默认自动开**(概念图里那格"异常时自动加深"刻意没做)。
		 */
		function settingsView(props) {
			const t = translate;
			const kept = state.watch.incidents.length;
			// 插件在 localStorage 里的实际占用(只读):事故 / sourcemap 缓存 / 其余,与落盘上限并排给
			const storage = storageReport();
			return [
				h('div', { style: S.block },
					h('div', { style: S.blockLabel }, t('settingsMode')),
					h('div', { style: { ...S.blockValue, color: state.deep === true ? 'var(--dsw-alias-brand-primary)' : undefined } },
						state.deep === true ? t('modeDeep') : t('modeWatch')),
					h('div', { style: S.sub, title: t('modeHint') }, t('modeHintShort')),
					h('div', { style: S.buttons },
						h('button', { type: 'button', style: S.btn, title: t('deepHint'), onClick: () => setDeep(state.deep === false) }, `${t('deepShort')}${state.deep ? '✓' : ''}`),
						h('button', { type: 'button', style: S.btn, onClick: () => setEnabled(state.on === false) }, state.on === true ? t('turnOff') : t('turnOn')))),
				h('div', { style: S.sep },
					h('div', { style: S.blockLabel }, t('settingsRetain')),
					h('div', { style: S.blockValue }, t('retainText')),
					h('div', { style: S.sub, title: t('retainKeptHint') },
						`${t('watchKept')} ${kept}${t('tallyUnit')} · ${t('watchTrimmed')} ${state.watch.trimmedByBytes}${t('tallyUnit')}`),
					// 丢失是**趋势窗口**（1 小时 / 24 小时）的数，留存是**当前**清单 —— 必须分行写窗口，
					// 否则「18 份 · 丢失 367」会被读成"丢了 367 份现场"（实测被这么问过）
					h('div', { style: S.sub, title: t('trendHint') },
						`${props.trendMs === TALLY_TREND_LONG_MS ? t('mainTrend24') : t('mainTrend1')}:${t('watchDetected')} ${props.trend.detected}${t('times')} · ${t('watchLost')} ${props.trend.lost}${t('times')}`),
					h('div', { style: S.sub, title: t('storageUseHint') },
						`${t('storageUse')} ${bytesText(storage.total)} · ${t('storageCap')} ${bytesText(storage.cap)}`),
					h('div', { style: S.sub },
						`${t('storageIncidents')} ${bytesText(storage.incidents)} · ${t('storageMaps')} ${bytesText(storage.maps)} · ${t('storageOther')} ${bytesText(storage.other)}`),
					h('div', { style: S.buttons },
						h('button', { type: 'button', style: S.btn, disabled: kept === 0, title: t('clearIncidentsHint'), onClick: () => props.onClearIncidents() }, t('clearIncidentsBtn')),
						h('button', { type: 'button', style: S.btn, title: t('clearHint'), onClick: () => props.onClearAll() }, t('clear')))),
				h('div', { style: S.sep },
					h('div', { style: S.blockLabel }, t('settingsPrivacy')),
					h('div', { style: S.blockValue }, t('privacyText')),
					h('div', { style: S.sub, title: t('privacyRedactionHint') }, t('privacyRedaction'))),
			];
		}
		/**
		 * 上下文标题栏:左边"这是哪个上下文",中间**核心耗时**(18px/600 等宽数字),右边一个动作。
		 * 实时与历史事故两支都从它开头 —— 两种模式一眼可辨(`实时监控 · 当前帧` / `历史事故 i12 · 历史帧`),
		 * 这是"不许把两种上下文混起来"这条要求在界面上的第一道锚。
		 */
		function contextBar(title, hero, action) {
			// data-ctx-bar:真页面验收器(tools/check-incident.mjs)靠它读"现在是哪个上下文"
			return h('div', { 'data-ctx-bar': '1', style: S.ctxBar },
				h('span', { style: S.ctxTitle }, title),
				hero === null ? null : h('span', { style: S.hero }, hero),
				action === null ? null : h('span', { style: { marginLeft: 'auto' } }, action));
		}
		/**
		 * 那个环:只画**一个维度**(四段:脚本 / 任务里没归到的 / 渲染 / 尾部),相加 = 这一帧。
		 * 尺寸是量出来的:48px 环的周长只有 126px(1% ≈ 1.3px),段一多就分不出来 → 84px,
		 * 段间留 1.4px 缝(小段扣不起缝就不扣)。
		 * 实时与历史事故**共用这一个函数**,只是喂进来的 `split` 不同:同一个口径、同一套颜色。
		 */
		function ringBlock(split) {
			const t = translate;
			if (split === null) return h('div', { style: S.row },
				h('span', { style: S.label, title: t('splitHint') }, t('split')),
				h('span', { style: S.num }, t('splitNoLoaf')));
			const R = 34;
			const C = 2 * Math.PI * R;
			const GAP = 1.4;
			const COLORS = {
				error: 'var(--dsw-alias-state-error-primary)',
				warn: 'var(--dsw-alias-state-warn-primary)',
				brand: 'var(--dsw-alias-brand-primary)',
				neutral: 'var(--dsw-alias-label-secondary)',
			};
			const slices = frameArcs(split);
			let passed = 0;
			const arcs = [];
			for (let i = 0; i < slices.length; i += 1) {
				const raw = (slices[i].ms / split.total) * C;
				// 缝只在"扣得起"的段上扣:小段扣掉缝就等于消失了
				const length = raw > GAP * 2 ? raw - GAP : raw;
				// 推进量按**原始**长度走,缝才落在两段之间(而不是把后面的段往前挪)
				const offset = passed;
				passed += raw;
				if (length <= 0.05) continue;
				arcs.push(h('circle', {
					key: `slice-${i}`, cx: 42, cy: 42, r: R, fill: 'none',
					stroke: COLORS[slices[i].color], strokeWidth: 13, strokeOpacity: slices[i].opacity,
					strokeDasharray: `${length.toFixed(1)} ${(C - length).toFixed(1)}`,
					strokeDashoffset: (-offset).toFixed(1),
					transform: 'rotate(-90 42 42)',
				}));
			}
			// 来源明细不在这一层(它在下面那条堆叠条里),tooltip 只讲环自己的四段
			const title = `${t('splitTotal')} ${split.total}ms(${t('splitWorst')} blocking ${split.blocking}ms)\n`
				+ `${t('splitScript')} ${split.js}ms(${t('jsExec')} ${split.exec} · ${t('forcedLayout')} ${split.forced} · ${t('jsPause')} ${split.pause})\n`
				+ `${t('splitTask')} ${split.taskOther}ms\n${t('splitRender')} ${split.render}ms\n${t('splitTail')} ${split.tail}ms`;
			return h('div', { style: { ...S.row, alignItems: 'center', gap: 8 } },
				h('svg', { width: 84, height: 84, viewBox: '0 0 84 84', style: { flex: '0 0 auto' } }, arcs),
				h('div', { style: { flex: '1 1 auto', textAlign: 'right', lineHeight: 1.5, minWidth: 0 } },
					h('div', { style: S.num, title }, `${t('split')} ${split.total}ms`),
					splitLegend(split).map((line, index) => h('div', { key: `legend-${index}`, title, style: S.sub }, line))));
		}
		/**
		 * 脚本侧往下拆的几行:**本帧那组 + 窗口那组**。实时与历史事故共用这一个函数
		 * (只是喂进来的 tally 与三个范围标签不同)—— 两边各写一份渲染,口径迟早会漂。
		 * 按包那几行只在真定到包名 / 真有「其余来源」时才出现。
		 */
		function scriptBreakdownRows(tallyFrame, tallyWindow, frameLabel, framePkgHint, windowHeadHint, windowPkgHint) {
			const t = translate;
			try {
			const rows = [];
			const line = (key, label, hint, value) => h('div', { key, style: S.block },
				h('span', { style: S.blockLabel, title: hint }, label),
				h('div', { style: S.blockValue }, value));
			const head = (key, text, hint) => h('div', { key, style: { ...S.blockLabel, marginTop: 8 }, title: hint }, text);
			// 一条 100% 堆叠横条:上面是"谁 + 毫秒"的文字(绝对值),下面是占比(段宽)。
			// 段宽按这一维度的总量算,所以条恒满格;名次靠由深到浅(与环同一套读法)。
			// ⚠️ 三处按**实测**调过(2026-10-08):① 填充不再从满不透明起步(顶段 0.5,逐级 .38/.28/.2)
			// —— 这个主题里 `brand-primary` 是近白 `rgb(249,250,251)`、`state-success-primary` 是纯绿
			// `rgb(34,197,94)`,满不透明就是一块发光色块,"占比"读不出来;
			// ② 段用 `flexGrow: 毫秒` + `flexBasis: 3px`:小段也占得住 3px(以前 6% 只有 21px × 0.28);
			// ③ 顶段 ≥ 80% 时在条右边内联一个占比 —— 比例严重偏斜时,"几乎全在一桶"要用数字说出来。
			// 每项一行的小表:名字左(超长省略,title 给全名)、毫秒右(等宽)。
			// 原来是"一整块右对齐长文本",折行会折在名字中间(实测 `ResizeObserverCallback` /
			// `index-5SrrfWpU.js` 都被劈成两半),读起来要先把断行拼回去。
			// 「按包」第一名是**应用外壳** bundle 时的那一句结论。外壳文件名(如
			// `index-CN7NIWNw.js`)排第一会让人读成元凶,而它从来不属于任何插件 —— 这一层
			// 就地说明,免得读者自己想起规则。数据来自 tally 的 shellMs / shellName。
			// ⚠️ 它是**内嵌闭包**而不是模块作用域函数:2026-10-19 曾把 `t(...)` 写在模块作用域,
			// 而 `t` 是本函数的局部别名 —— 三套件全绿、静态检查不响,真页面一展开「技术细节」
			// 就 ReferenceError,整块脚本拆解被降级成一行红字。内嵌之后拿不到局部 t 就不可能。
			const shellNote = (tally, key) => {
				if (tally === null || tally === undefined) return null;
				const shell = shellSummary(tally);
				if (shell === null) return null;
				return h('div', { key, style: { ...S.sub, marginTop: 2 }, title: t('shellNoteHint') },
					`${t('shellNote')} ${short(shell.name)} ${Math.round(shell.ms)}ms · ${Math.round(shell.share * 100)}%`);
			};
			const bar = (key, label, hint, list, token) => {
				const { segs, total } = barSegments(list);
				if (segs.length === 0 || total <= 0) return null;
				const topShare = segs[0].ms / total;
				const restCount = Math.max(0, (list ?? []).length - 3);
				return h('div', { key, style: { marginTop: 6 } },
					h('span', { style: S.blockLabel, title: hint }, label),
					h('div', { style: { marginTop: 2 } },
						segs.map((seg, index) => {
							// 「其余」那一项是合计数,没有单个名字可复制 —— 只有具名行才给动作
							const named = seg.name !== null;
							const text = named ? `${seg.name} ${Math.round(seg.ms)}ms` : translate('rest');
							return h('div', {
								key: `row-${index}`,
								title: named ? `${t('barCopyHint')}\n${text}` : translate('restHint'),
								style: { display: 'flex', gap: 8, alignItems: 'baseline', lineHeight: 1.45, cursor: named ? 'pointer' : 'default' },
								// 点一行复制「名字 + 毫秒」:这是真动作(剪贴板),不是装饰
								onClick: named ? () => copyText(text, t('copyName')) : undefined,
							},
								h('span', {
									style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' },
								}, named
									? short(seg.name)
									: `${translate('rest')}${restCount > 1 ? ` ${restCount}${translate('times')}` : ''}`),
								h('span', {
									style: { flex: '0 0 auto', fontFamily: MONO_FONT, fontVariantNumeric: 'tabular-nums' },
								}, `${Math.round(seg.ms)}ms`));
						})),
					h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 } },
						h('div', { style: { flex: '1 1 auto', display: 'flex', height: 8, borderRadius: 3, overflow: 'hidden', background: 'var(--dsw-alias-border-l2)' } },
							segs.map((seg, index) => {
								return h('div', {
									key: `seg-${index}`,
									title: `${seg.name === null ? translate('rest') : seg.name} ${Math.round(seg.ms)}ms · ${Math.round((seg.ms / total) * 100)}%`,
									style: {
										flexGrow: seg.ms, flexShrink: 1, flexBasis: 3,
										background: `var(${token})`,
										backgroundImage: `linear-gradient(rgba(0, 0, 0, ${[0.32, 0.46, 0.58, 0.68][index] ?? 0.68}), rgba(0, 0, 0, ${[0.32, 0.46, 0.58, 0.68][index] ?? 0.68}))`,
										boxShadow: index === 0 ? undefined : 'inset 1px 0 0 0 rgba(0, 0, 0, 0.6)',
										// ⚠️ 段本身**不给手型**:它是同一份数据的比例视图,点了没有别的去处。
										cursor: 'default',
									},
								});
							})),
						topShare >= 0.8
							? h('span', {
								key: 'share', title: t('barShareHint'),
								style: { ...S.label, flex: '0 0 auto', fontSize: 11, fontWeight: 400 },
							}, `${Math.round(topShare * 100)}%`)
							: null));
			};
			if (tallyFrame !== null && tallyFrame.js > 0) {
				rows.push(head('frame-head', frameLabel, t('splitJsHint')));
				rows.push(line('frame-js', t('splitJs'), t('splitJsHint'), jsBreakdownText(tallyFrame)));
				rows.push(bar('frame-src', t('bySource'), t('invokerHint'), tallyFrame.byInvoker, '--dsw-alias-brand-primary'));
				rows.push(bar('frame-pkg', t('byPkg'), framePkgHint, whoRows(tallyFrame), '--dsw-alias-state-success-primary'));
				const frameShell = shellNote(tallyFrame, 'frame-shell');
				if (frameShell !== null) rows.push(frameShell);
			}
			if (tallyWindow !== null && tallyWindow.js > 0) {
				rows.push(head('win-head', windowScopeText(tallyWindow), windowHeadHint));
				rows.push(bar('win-src', t('bySource'), t('invokerHint'), tallyWindow.byInvoker, '--dsw-alias-brand-primary'));
				// 全是纯执行时这一行只是把"脚本总耗时"重复一遍(条上已经看得到),不显示
				if (tallyWindow.forced + tallyWindow.pause > 0) rows.push(line('win-js', t('splitJs'), t('forcedHint'), jsBreakdownText(tallyWindow)));
				rows.push(bar('win-pkg', t('byPkg'), windowPkgHint, whoRows(tallyWindow), '--dsw-alias-state-success-primary'));
				const winShell = shellNote(tallyWindow, 'win-shell');
				if (winShell !== null) rows.push(winShell);
				// (这里原来有一条"一个包名都没定到 → 收敛成一行带分母的说明"的分支。它**永远不可达**:
				//  外层已经要求 window.js > 0,而 js > 0 就必然有脚本,那条脚本要么定到包(top 非空)、
				//  要么进 byOther —— 两个条件互斥,所以面板从来没渲染过它,套件却因为直接测那个函数而
				//  一直是绿的。现在真正的兜底在渲染路径上:whoRows(window) 把 top 与 byOther 一起喂给
				//  堆叠条,所以"一个包名都没定到"时看到的是**按原因命名的「其余来源」段(带毫秒)**。)
			}
			return rows.length === 0 ? null : h('div', null, rows);
			} catch (error) {
				// 这一块全是**派生统计**(细拆 / 两条条):任何一处算炸都只降级成一行可见的错误原文,
				// 并把原文记进导出件 —— 绝不再让整块取证面板被外壳停用。
				recordError(error);
				return h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-error-primary)' } },
					`${t('splitFailed')}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
			}
		}
		/**
		 * 「可疑脚本」那一块:把「事故/帧 → 来源 → 包 → 文件:行」落到**个体脚本**上。
		 * 上面那几块回答"时间花在哪个包 / 哪类调用"(排行),这一块回答"打开哪个文件、哪个函数"
		 * (定位)。它是**证据**,不是又一个排行榜 —— 只列 Top EVIDENCE_MAX,并把口径与缺口写在同一块里。
		 * 实时与历史事故共用它,`scope` 由 `evidenceScope()` 按上下文给出。
		 */
		function evidenceBlock(scope) {
			const t = translate;
			if (scope === null) return null;
			try {
				// 一条**能定位的**都没有(没开深录 / 脚本被压掉函数名)→ 换一行带分母的说明,
				// 不摆一列 `函数名未记录 @ 包未定名 + 毫秒`(那既没缩小范围又翻了几倍行数)
				if (scope.rows.length === 0) {
					return h('div', { style: { ...S.sub, marginTop: 8 }, title: `${t('evidenceHint')}\n${evidenceFooterTitle()}` },
						evidenceZeroText(scope));
				}
				return h('div', { style: { marginTop: 8 } },
					// 这一帧没有脚本记录、下面给的是窗口切片时,先把范围说出来(不含糊过去)
					scope.missing === true ? h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-warn-primary)' } }, t('frameEvidenceMissing')) : null,
					h('div', { style: { ...S.blockLabel, marginTop: 8 }, title: t('evidenceHint') }, scope.label),
					// 同一个函数 / 同一个位置的多次调用已经合并(members 留着),行首给 ×N,右列是**合计**
					h('div', { style: { marginTop: 2 } }, scope.rows.map((ev, index) => h('div', {
						key: `ev-${index}`,
						title: `${evidenceGroupLine(ev)}\n${t('evidenceCopyHint')}`
							+ `${evidenceLocatable(ev) === true ? '' : `\n${t('evidenceUnlocatableHint')}`}`,
						style: { display: 'flex', gap: 8, alignItems: 'baseline', lineHeight: 1.45, cursor: 'pointer' },
						onClick: () => copyText(evidenceGroupLine(ev), t('copyScript')),
					},
						h('span', {
							style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' },
						}, `${evidenceName(ev)}${(ev.count ?? 1) > 1 ? ` ×${ev.count}` : ''}`),
						h('span', {
							title: `${translate('evidenceWhere')} ${evidenceWhereText(ev)}`,
							style: { flex: '0 0 auto', fontFamily: MONO_FONT, fontVariantNumeric: 'tabular-nums' },
						}, `${Math.round(ev.ms)}ms`)))),
					h('div', { style: S.sub, title: evidenceFooterTitle() }, evidenceFooter(scope)));
			} catch (error) {
				// 派生统计算炸只降级成一行可见原文,不许带走整块面板(与其它几块同一条安全线)
				recordError(error);
				return h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-error-primary)' } },
					`${t('evidenceFailed')}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
			}
		}
		/**
		 * 包 × 来源**交叉表**(默认收起)。两个正交维度分开看是两张榜单,交叉起来才回答
		 * "哪个包的哪类回调在烧时间";只展开 Top3 × Top3,其余并进"其余"行/列(减法补足),
		 * 四块拼起来恒等于脚本总耗时。格子给毫秒(单位写在末尾),占比放 hover。
		 * 实时吃最近 200 条窗口的 tally,历史事故吃**整份事故包**的 tally —— 同一个函数。
		 */
		function crossBlock(tally, hint) {
			const t = translate;
			try {
				const cross = crossTable(tally);
				if (cross === null) return null;
				// **只有一格有值 -> 不画表**。那一格的答案上面两条堆叠条已经各说过一遍,3x3 里另外
				// 8 个 `·` 与底部重复的摘要只是噪音(实测截图:一格有值也画满 3x3)。
				if (cross.filled <= 1) {
					return group('cross', t('crossTable'), crossSummary(cross), () => h('div',
						{ style: { ...S.sub, marginTop: 2 }, title: hint ?? t('crossHint') },
						crossSingleText(cross)));
				}
				const pct = (ms) => `${Math.round((ms / (cross.js || 1)) * 100)}%`;
				const cellStyle = { flex: '1 1 0', textAlign: 'right', fontFamily: MONO_FONT, fontVariantNumeric: 'tabular-nums', fontSize: 12 };
				// 名字列**不钉 84px**:长包名会被截成 `插件批次(未...`。按这一批名字里最长的取宽
				// (上限 120px),title 给全名 —— 截断只发生在真的放不下时。
				const widest = Math.min(120, Math.max(...cross.rows.map((name) => short(name).length), 6) * 7 + 4);
				const nameStyle = { flex: `0 0 ${widest}px`, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
				const row = (key, label, cells) => h('div', { key, style: { display: 'flex', gap: 4, marginTop: 2 } },
					h('span', { style: nameStyle, title: label }, label), cells);
				const num = (key, ms, who, src) => h('span', {
					key, title: `${who} · ${src} ${Math.round(ms)}ms · ${pct(ms)}`,
					style: { ...cellStyle, color: ms > 0 ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)' },
				}, ms > 0 ? String(Math.round(ms)) : '·');
				const kids = [
					row('cross-head', t('crossCorner'), cross.cols.map((src) => h('span', {
						key: `h-${src}`, title: src, style: { ...nameStyle, flex: '1 1 0', textAlign: 'right' },
					}, short(src))).concat([
						h('span', { key: 'h-rest', style: { ...nameStyle, flex: '1 1 0', textAlign: 'right' } }, translate('rest')),
					])),
				];
				cross.rows.forEach((who, r) => kids.push(row(`cross-${who}`, short(who),
					cross.cols.map((src, c) => num(`c-${r}-${c}`, cross.grid[r][c], who, src))
						.concat([num(`c-${r}-rest`, cross.restCol[r], who, translate('rest'))]))));
				kids.push(row('cross-rest', translate('rest'),
					cross.cols.map((src, c) => num(`r-rest-${c}`, cross.restRow[c], translate('rest'), src))
						.concat([num('cross-corner-cell', cross.corner, translate('rest'), translate('rest'))])));
				kids.push(h('div', { key: 'cross-unit', title: hint ?? t('crossHint'), style: { ...S.sub, textAlign: 'right' } },
					`${translate('crossUnit')} · ${translate('crossBiggest')} ${short(cross.top.who)} · ${short(cross.top.src)} ${Math.round(cross.top.ms)}ms`));
				return group('cross', t('crossTable'), crossSummary(cross), () => kids);
			} catch (error) {
				// 交叉表是**派生统计**:它自己算炸了不该把整块取证面板带走(实测被报"点开就闪退":
				// `short(null)` 抛错 → 面板渲染抛错 → 外壳停用条目,面板整块消失)。降级成一行**可见**的
				// 错误原文,并把错误记进导出件 —— 不静默吞(§1「不许假装成功」)。
				recordError(error);
				return h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-error-primary)' } },
					`${t('crossFailed')}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
			}
		}
		/**
		 * 实时帧的翻帧行(最近 200 条长动画帧按严重度降序;◀ ▶ 换一条、⟲ 回到自动)。
		 * 它**只在实时上下文里出现** —— 历史事故用的是帧条 + 事故内的帧导航,两者不是同一份数据。
		 */
		function liveFramePickRow() {
			const t = translate;
			const list = pickList();
			if (list.rows.length === 0) return null;
			const current = pickedLoaf();
			const at = list.rows.findIndex((row) => row.t === current.t) + 1;
			const auto = state.watch.pickT === null;
			const shown = list.filtered ? list.rows.length : 0;
			const title = `${t('framePick')} ${at}/${list.rows.length}${list.filtered ? `(≥${PICK_MIN_MS}ms)` : ''}`
				+ ` · ${t('splitTotal')} ${Math.round(current.dur ?? 0)}ms · blocking ${Math.round(current.blocking ?? 0)}ms · ${clock(current.t)}`
				+ `\n${auto ? t('framePickAuto') : t('framePinned')}`
				+ (shown === 0 ? '' : `\n${translate('framePickFiltered')} ${shown}${translate('times')}`)
				+ `\n${t('framePickHint')}`;
			return h('div', { style: { ...S.row, alignItems: 'center' }, title },
				h('span', { style: S.label }, `${t('framePick')} ${at}/${list.rows.length} · ${Math.round(current.dur ?? 0)}ms${list.filtered ? ` · ≥${PICK_MIN_MS}ms` : ''}`),
				h('span', { style: { flex: '0 0 auto', display: 'flex', gap: 6 } },
					h('button', { type: 'button', style: S.btn, title: t('framePickHint'), onClick: () => pickStep(-1) }, '◀'),
					h('button', { type: 'button', style: S.btn, title: t('framePickHint'), onClick: () => pickStep(1) }, '▶'),
					h('button', { type: 'button', style: S.btn, title: t('frameAutoHint'), onClick: pickAuto }, '⟲')));
		}
		/**
		 * **历史帧时间轴 + 逐帧导航**。它不是一个装饰性的柱状图:
		 *   · 每一列都指向 `incident.frames` 里**真实存在**的那一帧(点击选中它);
		 *   · 整段 rAF 被挂起 / 采样缺失的地方**留白**,不补桩(那是"没在测",不是"没卡");
		 *   · 选中帧用一条蓝色竖线标出来,并给序号(窗口内第几帧)与耗时。
		 * 四个方向各一个按钮,没有下一条就**禁用**(不留一个点了没反应的动作)。
		 */
		function timelineBlock(row, frame, nav) {
			const t = translate;
			try {
			const timeline = replayColumns(row);
			if (timeline === null) return h('div', { style: S.sub }, t('pickNone'));
			const bars = [];
			for (const cell of timeline.cols) {
				if (cell === null) continue;
				const isGap = cell.frame === null;
				const height = isGap ? 2 : Math.max(2, Math.min(SPARK_REPLAY_HEIGHT, Math.round((cell.ms / SPARK_MAX_MS) * SPARK_REPLAY_HEIGHT)));
				bars.push(h('rect', {
					key: `c${cell.index}`, x: cell.index, y: SPARK_REPLAY_HEIGHT - height, width: 1, height,
					fill: SPARK_COLORS[cell.level],
					// 悬停给的是**这一格那一帧**的真实信息(编号 / 耗时 / 墙钟),不是这一格的平均
					title: replayCellTitle(row, cell, nav),
					style: isGap ? undefined : { cursor: 'pointer' },
					onClick: isGap ? undefined : () => selectIncidentFrame(cell.frame.t),
				}));
			}
			// 选中帧的标记:一条从顶到底的蓝线(盖在柱子上;柱子自己的颜色仍然表达它的档位)
			const selX = Math.min(REPLAY_COLS - 1.5, Math.max(0, replayX(frame.t, timeline.from, timeline.span, REPLAY_COLS)));
			bars.push(h('rect', { key: 'sel', x: selX, y: 0, width: 1.5, height: SPARK_REPLAY_HEIGHT, fill: 'var(--dsw-alias-state-business-primary)' }));
			const startAt = incidentWallClock(row, timeline.from);
			const endAt = incidentWallClock(row, timeline.to);
			const level = severityLevel(frame.ms ?? 0);
			const btn = (label, enabled, onClick) => h('button', {
				type: 'button', disabled: enabled === false, title: t('frameNavHint'),
				style: enabled === false ? { ...S.btn, opacity: 0.45, cursor: 'default' } : S.btn,
				onClick: enabled === false ? undefined : onClick,
			}, label);
			return h('div', { style: S.card },
				h('div', { style: S.cardTitle, title: t('replayTimelineHint') }, t('replayTimeline')),
				h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 2 } },
					h('span', { style: { ...S.sub, marginTop: 0 } }, startAt === null ? t('notYet') : clock(startAt)),
					h('span', { style: { ...S.sub, marginTop: 0 } }, endAt === null ? '' : clock(endAt))),
				h('svg', {
					width: '100%', height: SPARK_REPLAY_HEIGHT, viewBox: `0 0 ${REPLAY_COLS} ${SPARK_REPLAY_HEIGHT}`,
					preserveAspectRatio: 'none', style: { display: 'block', marginTop: 2 },
				}, bars),
				// 帧号与毫秒**只在上面那行上下文标题里给一次**(这里曾把同一句话说第二遍);
				// 三个导航控件并成一行:两对箭头做的是同一件事、只是步长不同,读的人得先弄清
				// "异常帧"是什么才敢按 —— 现在「只看异常」是一个过滤器,箭头还是那两个箭头。
				h('div', { style: { display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' } },
					h('span', { style: { ...S.sub, marginTop: 0, color: severityColor(level) }, title: t('sevBadHint') }, severityText(level)),
					h('span', { style: { flex: '1 1 auto' } }),
					btn(`◀ ${t('frameNavPrev')}`, nav.hasPrev, () => incidentFrameStep(-1)),
					btn(`${t('frameNavNext')} ▶`, nav.hasNext, () => incidentFrameStep(1)),
					h('button', {
						type: 'button',
						title: t('onlyBadHint'),
						style: { ...S.btn, color: state.watch.onlyBad === true ? 'var(--dsw-alias-state-business-primary)' : undefined },
						onClick: () => setOnlyBad(state.watch.onlyBad !== true),
					}, `${t('onlyBad')}${state.watch.onlyBad === true ? '✓' : ''}`)));
			} catch (error) {
				// 与其它派生块同一条安全线:算炸只降级成一行可见原文,不许带走整块面板
				recordError(error);
				return h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-error-primary)' } },
					`${t('replayFailed')}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
			}
		}
		/**
		 * long task 那一行的悬停全文:正文只念名字,悬停把**四条腿各自看到什么**摊开 ——
		 * 正文省略的那几条(子树 / DOM 写入 / 包名)正是读者追问"还有没有别的线索"时要看的。
		 */
		function longTaskTitle(task) {
			const t = translate;
			if (task === null || task === undefined) return t('frameLtTitle');
			const parts = [`${t('legFiber')} ${task.component ?? t('none')}`,
				`${t('legSubtree')} ${task.subtreeComponent ?? t('none')}`,
				`${t('legDom')} ${task.domComponent ?? t('none')}`,
				`${t('legOwner')} ${task.owner === null || task.owner === undefined ? t('none') : short(task.owner)}`];
			return `${longTaskLabel(task)}\n${parts.join(' · ')}\n${t('legScope')} ${task.source ?? t('none')}`;
		}
		/** 与这一帧**时间上重叠**的 long task(捕获时存下来的四条腿归因明细;没有就说没有)。 */
		function longTaskBlock(row, frame) {
			const t = translate;
			const tasks = incidentLongTasksAt(row, frame);
			const total = Array.isArray(row.longTasks) ? row.longTasks.length : 0;
			if (tasks.length === 0) {
				return h('div', { style: S.row },
					h('span', { style: S.label, title: t('frameLtTitle') }, t('frameLtTitle')),
					h('span', { style: S.num }, `${t('frameLtNone')} · ${t('frameLtWindow')} ${total}`));
			}
			return h('div', { style: S.block, title: t('frameLtTitle') },
				h('div', { style: S.blockLabel }, `${t('frameLtTitle')} · ${t('frameLtWindow')} ${total}`),
				h('div', { style: { marginTop: 2 } }, tasks.slice(0, EVIDENCE_MAX).map((task, index) => h('div', {
					key: `lt-${index}`,
					title: longTaskTitle(task),
					style: { display: 'flex', gap: 8, alignItems: 'baseline', lineHeight: 1.45 },
				},
					h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' } },
						longTaskLabel(task)),
					h('span', { style: { flex: '0 0 auto', fontFamily: MONO_FONT, fontVariantNumeric: 'tabular-nums' } }, `${Math.round(task.ms ?? 0)}ms`)))),
				tasks.length <= EVIDENCE_MAX ? null : h('div', { style: S.sub }, `${t('rest')} ${tasks.length - EVIDENCE_MAX}`));
		}
		/** 归因状态那一行:文字 + 档位色,并把"凭什么"摊在下一行(不留一句"未归因"就跑)。 */
		function verdictBlock(row) {
			const t = translate;
			const verdict = incidentVerdict(row);
			if (verdict === null) return null;
			return h('div', { style: S.block },
				h('div', { style: S.row },
					h('span', { style: S.label, title: t('verdictLabel') }, t('verdictLabel')),
					h('span', { style: { ...S.num, color: verdictColor(verdict.level) } }, verdict.label)),
				h('div', { style: S.sub }, verdict.detail));
		}
		/**
		 * 「技术细节」:环 / 脚本拆解 / 重叠 long task / 可疑脚本 / 包×来源 / 口径。
		 *
		 * 为什么要有它:**这一屏普通用户也会看到**(主界面「看这一次」的落点),而上面这些是给
		 * 开发者的读数。以前它们在卡顿详情里是**平铺**的 —— 同一份内容在开发者详情里反而收在
		 * 「取证明细」折叠里,于是"开发者的屏比普通用户的屏还简洁"。现在两边共用这一个组:
		 * 收起只留一行摘要,展开就是全部技术读数(能力一个都没删)。
		 */
		function techGroup(detail) {
			const t = translate;
			return group('tech', t('groupTech'), techSummary(detail), () => {
				// 这一帧没有 LoAF(只存了帧间隔)时,帧内分解与"重叠的 long task"都无从谈起 ——
				// 合成**一行**,而不是两个块各说一遍自己那份缺失(以前这里连着四行都在说"没有")。
				const noLoaf = detail.split === null || detail.split === undefined;
				const kids = [];
				if (noLoaf) {
					kids.push(h('div', { style: { ...S.sub, marginTop: 4 }, title: t('techNoneHint') }, t('techFrameNone')));
				} else {
					kids.push(ringBlock(detail.split));
				}
				// 脚本侧:本帧 + 事故窗口。窗口那一份即使这一帧没有记录也照给(它来自整份事故包)。
				kids.push(h('div', null, scriptBreakdownRows(detail.tallyFrame, detail.tallyWindow,
					t('ctxHistoryFrame'), t('pkgStoredHint'), t('incidentWindowScopeHint'), t('pkgIncidentWindowHint'))));
				if (noLoaf === false) kids.push(longTaskBlock(detail.row, detail.frame));
				kids.push(evidenceBlock(detail.evidence));
				kids.push(crossBlock(detail.tallyWindow, t('crossIncidentHint')));
				kids.push(h('div', { style: { ...S.sub, marginTop: 8 }, title: t('replayHint') }, t('replayScopeNote')));
				return kids;
			});
		}
		/**
		 * **历史事故上下文**的取证明细。数据全部来自 `detailContext()`(只吃事故包:
		 * `incident.frames` / `incident.loaf` / `summary` / `longTasks` / `urls`),所以:
		 *   · 刷新生效(事故落盘 + 上下文落盘),零新增采集;
		 *   · 实时帧环里别的帧、实时窗口聚合、记录器自身 / 最差那秒 / 帧内未归因 —— **一个都不进来**;
		 *   · 某一帧缺东西时写明缺什么,不回退去拿别的帧或实时数据顶上。
		 *
		 * 屏幕上分两层:**结论层**(上下文标题 / 这条事故的两个动作 / 回放范围 / 归因状态 /
		 * 时间轴)普通用户就够用;技术读数全在 `techGroup` 里,默认收起。
		 */
		function incidentDetail(detail) {
			const t = translate;
			const row = detail.row;
			if (row === null) return [h('div', { style: S.sub }, t('watchNone'))];
			const frame = detail.frame;
			const nav = detail.nav;
			const kids = [];
			kids.push(contextBar(
				incidentFrameHeadingText(row, frame, nav),
				frame === null ? null : `${Math.round(frame.ms ?? 0)}ms`,
				h('button', { type: 'button', style: S.btn, title: t('backToLiveHint'), onClick: showLiveMode }, t('backToLive'))));
			// 这一屏**唯一**的动作条:返回在标题栏(每个视图都有),这里只回答"这条事故怎么办"。
			// 以前它在视图外面又写了一份返回 + 这两个动作 —— 同屏两个「←」返回,位置还不一样。
			kids.push(h('div', { style: S.buttons },
				h('button', { type: 'button', style: S.btn, title: t('copySummaryHint'), onClick: () => copyText(incidentSummaryText(row), t('copySummary')) }, t('copySummary')),
				h('button', { type: 'button', style: S.btn, title: t('exportIncidentBtnHint'), onClick: () => exportIncident(row.id) }, t('exportIncidentBtn'))));
			// 采集本身丢过记录时,这一屏必须自己说出来 —— 否则"没看到证据"会被读成"没有证据"。
			if (row.integrity?.captureComplete === false) {
				const drop = row.integrity;
				kids.push(h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-warn-primary)' } },
					`${t('integrityIncomplete')} · LoAF ${drop.loafDropped} · LT ${drop.longTaskDropped}${drop.reasons.length === 0 ? '' : ` · ${drop.reasons.join(' · ')}`}`));
			}
			const scope = replayScope();
			if (scope !== null) {
				// 事故 id 只在上面那行上下文标题里出现一次(这里曾重复印一遍)
				kids.push(h('div', { style: S.block, title: t('replayHint') },
					h('div', { style: S.blockLabel }, t('replay')),
					h('div', { style: S.blockValue }, replaySummaryText(scope))));
			}
			kids.push(verdictBlock(row));
			if (frame === null) {
				// 老包 / 捕获失败:包里一条帧记录都没有 → 如实说,不摆空条,更不借实时帧
				kids.push(h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-warn-primary)' } }, state.pickNote ?? t('pickNone')));
				kids.push(h('div', { style: S.sub, title: t('replayHint') }, t('replayScopeNote')));
				return kids;
			}
			// 时间轴是**导航器**:帧号与耗时在上面的上下文标题里,这里只留档位与翻帧控件
			kids.push(timelineBlock(row, frame, nav));
			// 往下全是技术读数,默认收起(展开就是原来那一整套,一个都没删)
			kids.push(techGroup(detail));
			return kids;
		}
		/**
		 * **实时上下文**的取证明细。只吃实时帧环 / 实时窗口聚合 / 插桩读数 ——
		 * 与历史事故那一支完全分开(切模式就是切数据源,不是把两边的数字拼在一起)。
		 */
		function liveDetail(detail) {
			const t = translate;
			const tally = longTaskTally();
			const unexplained = unexplainedFrame();
			const selected = selectedIncident();
			return [
				contextBar(
					liveFrameHeadingText(detail.frame),
					detail.frame === null ? null : `${Math.round(detail.frame.dur ?? 0)}ms`,
					selected.row === null ? null : h('button', {
						type: 'button', style: S.btn, title: t('historyHint'),
						onClick: () => revealIncident(selected.row.id),
					}, `${t('ctxIncident')} ${selected.row.id}`)),
				// ① 60 秒帧条(趋势导航)
				h('div', { style: S.block },
					h('div', { style: S.blockLabel, title: t('sparkHint') }, t('spark')),
					h('div', { style: { marginTop: 2 } }, frameRing.size === 0 ? t('notYet') : sparkStrip())),
				// ② 实时翻帧(最近 200 条长动画帧)
				liveFramePickRow(),
				// ③ 这一帧的时间去向
				ringBlock(detail.split),
				// ④ 脚本侧(本帧 / 窗口)
				h('div', null, scriptBreakdownRows(detail.tallyFrame, detail.tallyWindow,
					t('scopeFrame'), t('pkgHint'), t('windowScopeHint'), t('pkgWindowHint'))),
				// ⑤ 可疑脚本(当前实时帧)
				evidenceBlock(detail.evidence),
				// ⑥ 窗口交叉表
				crossBlock(detail.tallyWindow),
				// ⑦ 时间分解之后:帧里"JS 之外"的残差 —— 唯一能反映 CSS/绘制卡顿的数字
				h('div', { style: S.row },
					h('span', { style: S.label, title: t('unattrHint') }, t('unattr')),
					h('span', { style: { ...S.num, color: state.deep === true && unexplained !== null ? 'var(--dsw-alias-state-warn-primary)' : undefined } },
						unattrText())),
				unexplained === null ? null : h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-warn-primary)' } },
					`${t('unexplained')}:${unexplained.ms}ms(${unexplained.percent}%)→ ${t('unexplainedHint')}`),
				h('div', { style: S.row },
					h('span', { style: S.label, title: t('recorderHint') }, t('recorder')),
					h('span', { style: S.num }, recorderText())),
				h('div', { style: S.row },
					h('span', { style: S.label }, t('worstSecond')),
					h('span', { style: S.num }, worstSecondText())),
				h('div', { style: S.row },
					h('span', { style: S.label }, t('topBlame')),
					h('span', { style: S.num }, (tally.topNames.length === 0
						? t('none')
						// 记录器自己不再挂在这行尾巴上 —— 它上面就有独立的「记录器自身」一行
						: tally.topNames.map(([name, count]) => `${short(name)} ${count}×`).join(' · ') + (tally.top.length > 3 ? ` · ${t('rest')} ${tally.top.length - 3}` : '')))),
				h('div', { style: S.row },
					h('span', { style: S.label, title: `${t('legFiber')} / ${t('legSubtree')} / ${t('legDom')} / ${t('legOwner')}` }, t('hit')),
					h('span', { style: S.num }, hitText(tally))),
			];
		}
		/**
		 * **审批卡**(composer takeover)的 rect —— `data-approval-key` 是外壳那侧给的稳定约定
		 * (见 `@deepseek-ai/dsh-client-ui-approval` 的 ApprovalPanel;类名是构建期哈希,不能用)。
		 * 没有审批卡时一次 querySelector 就返回,**不读布局**。
		 */
		function approvalCardRect() {
			const card = document.querySelector('[data-approval-key]');
			if (card === null) return null;
			const rect = card.getBoundingClientRect();
			return { top: rect.top, right: rect.right, width: rect.width, height: rect.height };
		}
		function PerfHud() {
			const [, force] = React.useState(0);
			const [open, setOpen] = React.useState(state.collapsed === false);
			const [draft, setDraft] = React.useState('');
			// ⚠️ 三处悬停联动(环 ↔ 按来源/按包堆叠条 ↔ 交叉表)**整体停用,而且把它那套
			// 辅助代码删掉了**(`hot` / `setHot` / `hotProps` / `hotStyle` 与各处的 `hot === …`)。
			// 为什么停用:2026-10-08 实测「鼠标指到交叉表的行标签」会让外壳把**整个条目停用** ——
			// 面板整块消失,而同期 `errors` 为空、`window.onerror` 不响、`__perfHud.enabled` 仍是 true;
			// 也就是说**它不经过我们自己的 HudBoundary**(抛点更可能在 `PerfHud()` 的函数体里,
			// 而 HudBoundary 是它返回的树的一部分),我们连错误原文都拿不到。
			// 2026-10-11 复核:**在当前代码上复现不出来** —— 真实鼠标依次扫过交叉表内 163 个元素
			// (外加用 JS 派发 153 次 `mouseover`)全程存活、`errors: 0`、ring 数不变,所以既
			// 不能证明根因、也不能证明已修好。按"稳定优先于观感"这条,**保持停用**。
			// 要重新尝试:先按上面那两种走法搭一个可复现的探针(遍历 DOM 顺序 + 装 console.error 钩子,
			// 注意钩子必须在 reload **之后**装),同时盯外壳日志里有没有 `slot entry crashed in …`;
			// 复现出来之前不要再往渲染里加 per-element 的鼠标状态。
			const setRoot = React.useCallback((element) => { state.root = element; }, []);
			React.useEffect(() => {
				// 只在"显示值变了"时渲染(兜底至少 2 秒一次):折叠着不动时 HUD 自身开销接近零。
				let lastKey = state.displayKey;
				let lastForced = performance.now();
				const id = natives.setInterval(() => {
					const changed = state.displayKey !== lastKey;
					const stale = performance.now() - lastForced >= 2000;
					if (changed === false && stale === false) return;
					lastKey = state.displayKey;
					lastForced = performance.now();
					force((n) => (n + 1) % 1000000);
				}, 500);
				// 用户动作 / 自测需要"点了立刻渲染":暴露到模块级,不等下一次 tick。
				state.requestRender = () => {
					lastKey = state.displayKey;
					lastForced = performance.now();
					force((n) => (n + 1) % 1000000);
				};
				return () => {
					natives.clearInterval(id);
					state.requestRender = null;
					state.toggleHud = null;
				};
			}, []);

			const t = translate;
			// 面板宽度随视口收(手机上定宽 396 会溢出去);药丸在窄屏转紧凑档。
			// 两个判据都是纯函数,真页面那侧由 tools/check-panel.mjs 在 393px 视口下验。
			const panelWidth = panelWidthFor(W.innerWidth);
			const compact = pillCompact(W.innerWidth);
			// ── 位置(拖动 / 记忆)──────────────────────────────────────────────
			// 锚点是**左下角**(left + bottom):默认停右下角时就是底边钉住、向上长,拖动之后保持
			// 同一个生长方向 —— 换成左上角锚,面板摆到屏幕中部点开就会向下长,底边一路掉到视口底。
			// 拖动时只把 right 置 auto(bottom 要留着当锚),位置只活在 `state.pos` 里。
			// 宽度只有 panelWidth 一个来源:展开态就是它,收起态由 S.root 的 maxWidth 封顶到它 ——
			// 所以夹紧用它当上界对两种形态都成立(收起态不该拿"上次拖动时的宽度"当尺子)。
			const isOpenPanel = open === true && state.on !== false;
			const pos = state.pos === null ? null : hudPosClamp(
				state.pos,
				{ w: panelWidth },
				{ w: W.innerWidth, h: W.innerHeight },
				isOpenPanel ? HUD_POS_MIN_ROOM : HUD_POS_PILL_ROOM,
			);
			// 水平只写**一个**锚点:左锚为 left,右锚为 right,另一个置 auto。
			// 右锚是"贴右边"的语义 —— 胶囊(168px)贴在最右,打开成面板(396px)时右边缘不动、只向左长。
			const posStyle = pos === null ? null : {
				bottom: pos.bottom, top: 'auto',
				...(Number.isFinite(pos.left) ? { left: pos.left, right: 'auto' } : { right: pos.right, left: 'auto' }),
				// 底边钉住之后,高度上限是"顶边还剩多少"(与默认位置的 82vh 同一套算法)
				...(isOpenPanel ? { maxHeight: hudPosMaxHeight(pos.bottom, { h: W.innerHeight }) } : null),
			};
			// 审批卡让位:那两个真按钮(拒绝 / 允许一次)在卡片右下角,正压在我们这一列上 ——
			// 遮住批准按钮是这个面板最不该干的事。判定是纯函数(见 hudDodge),这里只量一次 DOM。
			//
			// ⚠️ 让位只对**默认位置**生效:用户亲手摆过的位置由用户负责(面板已经能一拖就走),
			// 自动让位再插手就成了"两个东西抢同一组 CSS"—— 手动摆好的面板会在卡片弹出时跳走。
			const dodge = pos !== null ? null : hudDodge({
				card: approvalCardRect(),
				viewport: { w: W.innerWidth, h: W.innerHeight },
				width: panelWidth,
			});
			const dodgeStyle = dodge === null ? null : {
				bottom: dodge.bottom,
				maxHeight: dodge.maxHeight,
				...(dodge.left === true ? { left: 12, right: 'auto' } : null),
			};
			const toggle = () => {
				const next = open === false;
				setOpen(next);
				// 展开药丸 = 回到"日常那一屏"(主界面);开发者详情 / 设置是显式入口,
				// 不因为上次停在那就一直停在那 —— 否则普通用户点开看到的是一屏技术数据。
				if (next === true) setView('main');
				state.collapsed = next === false;
				try { localStorage.setItem(LS_UI, next ? '0' : '1'); } catch (error) { /* 折叠状态记不住无所谓 */ }
			};
			// 快捷键走同一个 toggle(不另写一份展开状态,否则两处会不同步)。
			state.toggleHud = toggle;
			/**
			 * 拖动标题栏。三条要点(前两条抄自 dsh-better-sidebar 的 FloatingWindow,那边真页面验过):
			 * ① 指针用 **window 级监听**,不在面板上做 pointer capture —— capture 会把后续 click 的
			 *    target 重定向到捕获元素,标题栏里的按钮(设置 / 收起 / 关闭)就点不动了;
			 * ② 移动期间**直接写 DOM 样式**,不走 React state:每次 pointermove 重渲染一次整块面板,
			 *    而面板自己正在测帧 —— 拖 HUD 会变成 HUD 记下的一次卡顿;
			 * ③ 松手才落盘 + bump 一次,让 React 的 style diff 跟上(否则下一次「恢复默认布局」
			 *    删不掉拖动留下的内联样式)。
			 */
			/**
			 * 把位置写进**根节点的内联样式**(拖动中与松手时共用)。
			 * 为什么要自己写而不是只交给 React:拖动期间我们直接改了 DOM 的 `left/right`,
			 * 而 React 的 style diff 只跟它上次的 props 比 —— 若松手后的 props 与拖动前**恰好相同**
			 * (典型:胶囊贴到最右,`right` 前后都是 12),React 认为没变化就不会重写,于是 DOM 停在
			 * 拖动时写下的 `right: auto` 上,元素掉到左边(实测:胶囊拖到最右后 left = 0)。
			 * 所以松手时按最终锚点自己写一遍,保证 DOM 与"下一次渲染会写出的值"一致。
			 */
			const applyPosStyle = (element, p, openNow) => {
				if (Number.isFinite(p.left)) {
					element.style.left = `${p.left}px`;
					element.style.right = 'auto';
				} else {
					element.style.right = `${p.right}px`;
					element.style.left = 'auto';
				}
				element.style.bottom = `${p.bottom}px`;
				element.style.top = 'auto';
				if (openNow === true) element.style.maxHeight = `${hudPosMaxHeight(p.bottom, { h: W.innerHeight })}px`;
			};
			const startDrag = (event) => {
				if (event.pointerType === 'mouse' && event.button !== 0) return;
				const target = event.target;
				if (target instanceof Element && target.closest('button, input, select, textarea, a') !== null) return;
				const root = state.root;
				if (root === null) return;
				const rect = root.getBoundingClientRect();
				// 量的是**底边距视口底**的距离:拖动只改 left / bottom,底边这个锚点全程不换。
				// `w` 是拖动开始时这一块的真实宽度 —— 夹紧必须按它算:胶囊只有 ~168px,按 panelWidth(396)
				// 算的话它永远拖不到最右边(左边被卡在"视口 − 396 − 12")。
				const start = { x: event.clientX, y: event.clientY, left: rect.left, bottom: Math.round(W.innerHeight - rect.bottom), w: Math.round(rect.width) };
				const room = isOpenPanel ? HUD_POS_MIN_ROOM : HUD_POS_PILL_ROOM;
				let moved = false;
				const onMove = (move) => {
					const dx = move.clientX - start.x;
					const dy = move.clientY - start.y;
					// 3px 之内算手抖:标题栏不是按钮,但"点一下"也不该把位置改成一个和默认差 1px 的状态
					if (moved === false && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
					moved = true;
					const next = hudPosClamp({ left: start.left + dx, bottom: start.bottom - dy },
						{ w: start.w }, { w: W.innerWidth, h: W.innerHeight }, room);
					state.pos = next;
					applyPosStyle(root, next, isOpenPanel);
				};
				const onUp = () => {
					W.removeEventListener('pointermove', onMove);
					W.removeEventListener('pointerup', onUp);
					W.removeEventListener('pointercancel', onUp);
					if (moved === false) return;
					// 松手这一下才决定水平锚点:贴哪边近就锚哪边(见 hudPosMake)。拖动过程中一直是
					// 左锚的临时写法,两种写法的像素位置完全相同,所以这里换锚不会跳。
					const finalRect = root.getBoundingClientRect();
					const finalPos = hudPosClamp(hudPosMake({ left: finalRect.left, right: finalRect.right, bottom: finalRect.bottom },
						{ w: W.innerWidth, h: W.innerHeight }), { w: panelWidth }, { w: W.innerWidth, h: W.innerHeight }, room);
					state.pos = finalPos;
					applyPosStyle(root, finalPos, isOpenPanel);
					saveHudPos();
					bump();
				};
				event.preventDefault();
				W.addEventListener('pointermove', onMove);
				W.addEventListener('pointerup', onUp);
				W.addEventListener('pointercancel', onUp);
			};
			/** 双击标题栏 = 回到默认右下角(与「恢复默认布局」里那次复位是同一个动作)。 */
			const resetPos = () => {
				if (state.pos === null) return;
				state.pos = null;
				saveHudPos();
				bump();
			};
			// 视口变了(换屏幕 / 改窗口大小 / 手机转屏)之后把自定义位置夹回来,不然它会整个留在屏幕外。
			React.useEffect(() => {
				let frame = null;
				const onResize = () => {
					if (frame !== null || state.pos === null) return;
					frame = W.requestAnimationFrame(() => {
						frame = null;
						if (state.pos === null) return;
						const next = hudPosClamp(state.pos, { w: panelWidth },
							{ w: W.innerWidth, h: W.innerHeight }, open === true ? HUD_POS_MIN_ROOM : HUD_POS_PILL_ROOM);
						const sameOffset = Number.isFinite(next.left) ? next.left === state.pos.left : next.right === state.pos.right;
						if (sameOffset && next.bottom === state.pos.bottom) return;
						state.pos = next;
						saveHudPos();
						bump();
					});
				};
				W.addEventListener('resize', onResize);
				return () => {
					W.removeEventListener('resize', onResize);
					if (frame !== null) W.cancelAnimationFrame(frame);
				};
			}, [open]);
			// 收起/展开不抢焦点:外壳在键盘命令之后会把焦点还给输入框;与它抢只会让用户丢焦点。
			if (state.on === false) {
				return h('div', { ref: setRoot, id: ROOT_ID, style: { ...S.root(false, panelWidth), ...posStyle, ...dodgeStyle } },
					h('div', { style: { ...S.head, ...S.drag }, title: t('dragHint'), onPointerDown: startDrag, onDoubleClick: resetPos },
						h('span', { style: S.label }, `${t('title')} · ${t('off')}`),
						h('button', { type: 'button', style: S.btn, onClick: () => setEnabled(true) }, t('turnOn'))));
			}

			const worst = worstLongTask();
			const link = linkStats();
			const linkSuspect = suspectLink();
			const idleBase = state.idleBaseline;
			const infra = infraVerdict();
			const hostFresh = hostFreshness();
			const rows = pluginTable();
			const top = rows.slice(0, TOP_N);
			const rest = rows.slice(TOP_N);
			// 首屏「最差事件」块吃的这一份上下文:默认自动跟严重度最差那条;用户在清单里点过就跟
			// 他选的那条(选中的被挤出留存清单时 selectedIncident 自己退回自动)。
			const selected = selectedIncident();
			const selectedRow = selected.row;
			const selectedLevel = severityLevel(selectedRow === null ? null : selectedRow.severity);

			const scene = sceneChip();
			// 落盘的是"上次在看哪个视图",而事故可能已经被挤出留存清单 —— 那时退回主界面,
			// 不去渲染一个空的历史上下文(与 selectedIncident 的退回自动是同一条规矩)。
			const view = state.view === 'incident' && state.watch.mode !== 'incident' ? 'main' : state.view;
			const viewTitle = view === 'dev' ? t('viewDev') : view === 'settings' ? t('viewSettings') : t('viewIncident');
			// 返回的落点:设置页回它来的那一屏,其余子页回主界面(2026-10-24 flow 修正)。
			const backTo = view === 'settings' && state.settingsBack !== 'settings' ? state.settingsBack : 'main';
			const head = h('div', { style: { ...S.head, ...S.drag }, title: t('dragHint'), onPointerDown: startDrag, onDoubleClick: resetPos },
				h('div', { style: S.headLeft },
					// 返回是**图标**:它每一屏都在,却只在子页出现 —— 三个汉字换成 14px 的箭头,
					// 把这一行的宽度留给标题与读数。
					view === 'main' ? null : h('button', {
						type: 'button', className: 'picon', style: S.iconBtn, title: t('backHint'), 'aria-label': t('back'),
						onClick: () => setView(backTo),
					}, panelIcon('back')),
					// 子页只写视图名:「性能 HUD ·」那一段与下面第一行的上下文标题(`历史事故 i35xx · 历史帧 …`)
					// 说的是同一件事(我在哪),而它是这一行里唯一能让位的文字。品牌名进悬停。
					h('span', { style: S.brand, title: t('title') }, view === 'main' ? t('title') : viewTitle),
					// 场景标签与标题一样是**文字**,一样可以让位(先出省略号):不变的是控件。
					h('span', { style: { ...S.label, color: scene.color, flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, scene.text),
					view === 'main' ? null : h('span', { style: { ...S.num, flex: '0 0 auto', color: levelFrame(state.fps, state.frameWorst) } }, `${state.fps.toFixed(1)} fps`)),
				h('div', { style: S.headRight },
					h('button', { type: 'button', className: 'picon', style: S.iconBtn, title: t('settingsHint'), 'aria-label': t('viewSettings'), onClick: () => setView(view === 'settings' ? backTo : 'settings') }, panelIcon('sliders')),
					h('button', { type: 'button', className: 'picon', style: S.iconBtn, title: open ? t('collapse') : t('expand'), 'aria-label': open ? t('collapse') : t('expand'), onClick: toggle }, panelIcon(open ? 'minus' : 'plus')),
					h('button', { type: 'button', className: 'picon', style: S.iconBtn, title: t('turnOff'), 'aria-label': t('turnOff'), onClick: () => setEnabled(false) }, panelIcon('close'))));

			if (open === false) {
				// 折叠不是"看不见":至少留下 fps / 最差帧 / 最差 longtask 三个读数。
				//
				// 「抓到 N 次」这一格原来写的是 `state.watch.incidents.length` —— 那是**留存了几份
				// 详细现场**,受容量限制(最差 10 次 + 每天 1 条)。把它当"发生了多少次卡顿"会系统性
				// 少报:被挤掉的卡顿不是没发生。现在这一格给的是**跨刷新的 24 小时检测次数**
				// (`tallyWindow`),留存数 / 丢失数放进悬停(`tallyTitle`)—— 三个数各有各的名字。
				const pillTally = tallyWindow(TALLY_MINUTES * TALLY_BUCKET_MS);
				return h('div', { ref: setRoot, id: ROOT_ID, style: { ...S.root(false, panelWidth), ...(compact === true ? null : { minWidth: panelWidth }), ...posStyle, ...dodgeStyle } },
					h('div', { style: { ...S.head, ...S.drag }, title: t('dragHint'), onPointerDown: startDrag, onDoubleClick: resetPos },
						h('span', { style: S.brand }, t('title')),
						h('span', { style: { ...S.label, color: sceneChip().color } }, sceneChip().text),
						h('span', { style: { ...S.num, flex: '0 0 auto', marginLeft: 'auto', color: levelFrame(state.fps, state.frameWorst) } }, `${state.fps.toFixed(0)} fps`),
						h('span', { style: S.label }, `${t('frameWorst')} ${state.frameWorst.toFixed(0)}ms`),
						worst === null ? null : h('span', { style: S.label }, `LT ${worst.ms.toFixed(0)}ms`),
						// 窄屏只让这一格(明细本来就在悬停与设置页里):实测整条读数要 ~425px,
						// 393px 视口把它丢掉之后其余读数才不挤成"生… 空闲 2s 12 fps…"。
						pillTally.detected === 0 || compact === true ? null : h('span', { style: S.label, title: tallyTitle(TALLY_MINUTES * TALLY_BUCKET_MS) }, `${t('watchDetected')} ${pillTally.detected}${t('times')}`),
						h('button', { type: 'button', style: S.btn, title: t('expand'), onClick: toggle }, '+'),
						h('button', { type: 'button', style: S.btn, title: t('turnOff'), onClick: () => setEnabled(false) }, t('turnOff'))));
			}

			// ── 开发者详情:原来那一整套技术数据(一个都没删),按标签页分组,一次看一组 ──
			const devFrames = [
				// ── 常显 1:当前状况(卡不卡 + 谁的锅)──
				// 块式而不是 flex 行:这一行长文本换行在右对齐下会参差得像段落(实测被吐槽)。
				// 标题里带「近 60 秒」:帧 / 长任务 / 命中三个数都是这个窗口的口径,不写出来只能猜。
				h('div', { style: S.block, title: overviewTitle() },
					h('div', { style: S.blockLabel }, `${t('overview')} · ${t('scope60s')}`),
					h('div', { style: { ...S.blockValue, color: levelFrame(state.fps, state.frameWorst) } }, `${overviewLine1()}\n${overviewLine2()}`)),

				// ── 常显 2:事故诊断入口(守夜留下的事故;严重度用**文字 + token 颜色**两样给)──
				// 这是"事故 → 帧 → 证据 → 来源/包"那条链的起点:三个按钮都是真动作(进历史事故上下文 /
				// 下载这条事故包 / 复制结论),不是装饰。默认跟最差那条 —— 「最差」不是「最近」,
				// 所以时间和"自动/已选中"都写在上面。
				h('div', { style: S.sep },
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('worstEventHint') }, t('worstEvent')),
						h('span', { style: { flex: '1 1 auto', display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 6, minWidth: 0 } },
							h('span', { style: { ...S.num, flex: '0 0 auto', color: selectedRow === null || state.watch.on === false ? 'var(--dsw-alias-label-secondary)' : severityColor(selectedLevel) }, title: t('sevBadHint') },
								eventValueText(selectedRow)),
							// 一键在「最差 / 最近」之间切"自动跟着谁":默认最差(事后回看的重点),但
							// "刚刚那一下卡在哪"同样常问 —— 两个都要够得着,又不要多一张清单。
							h('button', {
								type: 'button', style: S.btn, title: t('evScopeHint'), disabled: selectedRow === null,
								onClick: () => setIncidentScope(state.watch.scope === 'latest' ? 'worst' : 'latest'),
							}, state.watch.scope === 'latest' ? t('evWorst') : t('evLatest')))),
					selectedRow === null ? null : h('div', { style: S.sub, title: t('envPickHint') },
						`${watchSelectedText()} · ${selected.auto ? (state.watch.scope === 'latest' ? t('evAutoLatest') : t('evAutoWorst')) : t('evPinned')}`),
					// 归因状态:已确认 / 可疑 / 未归因 —— 文字与档位色两样一起给,"凭什么"单独一行
					selectedRow === null ? null : h('div', { style: S.sub, title: t('verdictLabel') }, eventEvidenceText(selectedRow)),
					selectedRow === null ? null : h('div', { style: { ...S.sub, color: verdictColor(incidentVerdict(selectedRow).level) } }, eventVerdictText(selectedRow)),
					selectedRow === null ? null : h('div', { style: S.sub }, eventWindowText(selectedRow)),
					selectedRow === null ? null : h('div', { style: S.buttons },
						// 上下文切换:**实时 ⇄ 历史事故**。两种模式各有一个"去另一边"的动作,
						// 当前在哪一边由取证明细第一行的上下文标题与这里一起说清。
						// 「复制摘要 / 导出事故包」**不在这里** —— 它们是"对这条事故做什么",属于
						// 卡顿详情那一屏自己的动作条(同一屏出现两份只会让人猜哪一份是真的)。
						diagMode() === 'incident'
							? h('button', { type: 'button', style: S.btn, title: t('backToLiveHint'), onClick: showLiveMode }, t('backToLive'))
							: h('button', { type: 'button', style: S.btn, title: t('viewEvidenceHint'), onClick: () => revealIncident(selectedRow.id) }, t('viewEvidence'))),
					state.copyNote === null ? null : h('div', { style: S.sub }, state.copyNote),
					watchFlagText() === null ? null : h('div', { style: { ...S.sub, title: t('watchHint') } }, watchFlagText())),

				// ── 常显 3:回调归因 Top3(每插件一行,hover 补 msps 与累计)──
				// 这一块**总有**:以前没插桩时整段不渲染,于是首屏根本没有"回调归因"这一层,
				// 读者分不清"没采"还是"采了是空的"。现在未插桩时降级成一行「要深录」——
				// 绝不写 `0ms/s`(那会被读成"没有开销");插桩之后 `0ms/s` 才是真的(确实没有回调跑过)。
				// 帧内未归因不在这里,它在「取证明细」(它是"解释",不是"现在卡不卡 / 谁的锅")。
				h('div', { style: S.sep },
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('blameHint') }, t('blame')),
						h('span', { style: S.num }, state.deep !== true ? t('needDeep') : msPerSecText(state.attributedPerSec))),
					state.deep !== true || top.length === 0 ? null : h('div', null, top.map((row, index) => h('div', { key: row.id, style: S.row },
						h('span', {
							style: S.label,
							title: `${row.id}\n` +
								`${t('cnExec')} ${row.cps}${t('perSec')}(${t('peak')} ${row.cpsPeak}${t('perSec')},EMA)\n` +
								`${t('cnCost')} ${row.msps}ms${t('perSec')}\n` +
								`${t('cumulative')} ${row.count}${t('times')} / ${row.ms.toFixed(0)}ms\n` +
								t('cnScope'),
						}, `${index + 1}. ${short(row.id)}`),
						h('span', { style: S.num }, attrText(row))))),
					state.deep !== true || rest.length === 0 ? null : h('div', { style: S.row },
						h('span', { style: S.label, title: restTitleText(rest) }, `${t('rest')} (${rest.length})`),
						h('span', { style: S.num }, restValueText(rest)))),

				// ── 布局工具:**按需出现**。默认布局下「全部折叠」已经没什么可收、「恢复默认布局」
				// 点了也不会变 —— 常驻两个"点了没反应"的按钮比不显示更糟,所以各自只在有意义时出现;
				// 两者都没意义时整行不渲染(首屏也就少一行)。
				(anyGroupOpen() || layoutDirty()) ? h('div', { style: { ...S.sep, display: 'flex', gap: 6 } },
					anyGroupOpen() ? h('button', { type: 'button', style: S.btn, title: t('collapseAllHint'), onClick: collapseAll }, t('collapseAll')) : null,
					layoutDirty() ? h('button', { type: 'button', style: S.btn, title: t('resetLayoutHint'), onClick: resetLayout }, t('resetLayout')) : null) : null,

				// ── 折叠 1:取证明细(最差那秒 + DOM 写入者)──
				// ⚠️ 子节点走**惰性回调**:这一组里全是"算了但不显示"的派生统计(脚本按包 /
				// 交叉表 / 帧条),折叠时连函数体都不该进(见 group() 的说明)。
				// ── 折叠 1:取证明细(实时 / 历史事故两支,**同一时间只显示一支**)──
				// 上下文只在这里分流一次:`detailContext()` 决定全部读数来自实时帧环还是事故包;
				// 渲染那侧只读它的结果 —— 所以"上面是历史事故、下面是另一条实时帧"在结构上无处发生。
				group('detail', detailGroupLabel(), detailSummary(), () => {
					const detail = detailContext();
					return detail.kind === 'incident' ? incidentDetail(detail) : liveDetail(detail);
				}),

			];
			const devDom = [
				// ── 折叠 2:DOM 与堆 ──
				group('dom', t('groupDom'), domSummary(), () => [
					h('div', { style: S.row },
						h('span', { style: S.label }, `${t('dom')} · ${t('rateWindow')}`),
						h('span', { style: S.num }, `${state.dom.total} · ${rateText(state.dom.series)}`)),
					TARGETS.map((target) => {
						const entry = state.targets.get(target.id);
						return h('div', { key: target.id, style: S.row },
							h('span', { style: S.label }, target.label()),
							h('span', { style: S.num }, entry === undefined || entry.nodes === null ? t('none') : `${entry.nodes} · ${rateText(entry.series)}`));
					}),
					state.heap === null ? null : h('div', { style: S.row },
						h('span', { style: S.label }, t('heap')),
						h('span', { style: S.num }, `${mb(state.heap)}MB · ${heapRateText()}`)),
					// DOM 写入属于「DOM 与堆」,不属于「取证明细」—— 那组回答的是"这一帧的时间去哪了"。
					// 这两行只有插桩了才有意义(不插桩时计数恒为 0,那时它们只会被读成"没有开销")
					state.deep !== true ? null : h('div', { style: S.row },
						h('span', { style: S.label, title: t('domWritesHint') }, t('domWrites')),
						h('span', { style: S.num }, String(state.mutations))),
					state.deep !== true ? null : writeRows(),
				]),

			];
			const devHost = [
				// ── 折叠 3:宿主与链路(排查"是页面卡还是链路卡"才看)──
				group('host', t('groupHost'), hostSummary(), () => [
					h('div', { style: S.row },
						h('span', { style: S.label }, t('stream')),
						h('span', { style: S.num }, `${state.streaming ? t('running') : t('idle')}${state.streaming || state.idleSince === 0 ? '' : ` ${Math.round((performance.now() - state.idleSince) / 1000)}s`}${state.baselineRunning ? ` · ${t('idleBase')}…` : ''}`)),
					h('div', { style: S.row },
						h('span', { style: S.label }, `${t('hostLoop')} · ${t('verdict')}`),
						h('span', { style: { ...S.num, color: infra.color } }, infra.text)),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('hostLoop')),
						h('span', { style: { ...S.num, color: hostFresh.state === 'live' ? levelUp(hostFresh.loop.p99, 50, 200) : hostFresh.state === 'stale' || hostFresh.state === 'unreachable' ? 'var(--dsw-alias-state-warn-primary)' : undefined } },
							hostLoopStateText())),
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('hostEventsHint') }, t('hostEvents')),
						h('span', { style: S.num }, hostEventsText())),
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('linkHint') }, t('link')),
						h('span', { style: { ...S.num, color: linkSuspect ? 'var(--dsw-alias-state-warn-primary)' : (link.count > 0 ? levelUp(link.p99, 100, 300) : undefined) } }, linkRowText())),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('idleBase')),
						h('span', { style: S.num }, idleBase === null || idleBase === undefined
							? t('notYet')
							: `${idleBase.fps}fps · LT ${idleBase.longTasks} · ${idleBase.domPerMin}${t('perMin')}`)),
					idleBase === null || idleBase === undefined || idleBase.domPerMin <= 0 ? null : h('div', { style: S.sub },
						`${t('idleWriter')}: ${(idleBase.domTop ?? []).map((row) => `${short(row?.id ?? '?')}${row?.component === null || row?.component === undefined ? '' : `(${row.component})`}`).join(' / ') || t('none')}`),
				]),

			];
			const devTools = [
				// ── 折叠 4:工具箱(事故清单 / 场景标记 / 整机导出)──
				group('tools', t('groupTools'), toolsSummary(), () => [
					// 守夜层:最差几次的清单 + 手动补记 + 导出最近一次
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('watchHint') }, t('watch')),
						h('span', { style: S.num }, watchPanelText())),
					// 清单按**严重度**排(不是时间序):点一条就选中它 —— 首屏「最差事件」块与
					// 「取证明细」的翻帧都跟着走。它真能导航到同一条事故,所以才做成可点的行。
					state.watch.incidents.length === 0 ? null : h('div', { title: t('envPickHint') },
						state.watch.incidents.map((row, index) => h('div', {
							key: row.id,
							style: { ...S.sub, cursor: 'pointer', fontWeight: state.watch.selId === row.id ? 700 : 400 },
							title: t('envPickHint'),
							onClick: () => selectIncident(row.id),
						}, watchRowText(row, index)))),
					h('div', { style: S.buttons },
						// 备注输入框留着:它就是「标记刚才」写进事故包的 note
						h('input', {
							type: 'text',
							value: draft,
							placeholder: t('markPlaceholder'),
							onChange: (event) => setDraft(event.target.value),
							style: S.input,
						}),
						h('button', { type: 'button', style: S.btn, disabled: state.watch.on === false, title: t('watchMarkHint'), onClick: () => { W.__perfHud.capture(draft === '' ? t('watchManualNote') : draft); setDraft(''); } }, t('watchMark'))),
					// 导出 / 清空**只在「原始数据」那一页**(见 devRaw):同四个按钮在相邻两个标签页
					// 各摆一份,点错地方只是白点一次,读的人还要先弄清两页有什么区别。
				]),
			];

			// ── 原始数据(标签页 5):导出与交接件的入口 ──
			const devRaw = [
				h('div', { style: S.row },
					h('span', { style: S.label, title: t('packFilesHint') }, t('packFilesLabel')),
					h('span', { style: S.num }, t('packFilesValue'))),
				h('div', { style: S.buttons },
					// 两条路**只差自由文本**:给 AI 的那条置空并标 noteDropped,本机调试件保留。
					// 所以标题必须自己说清是哪一条(免得"以为导出的是同一份")。
					h('button', { type: 'button', style: S.btn, title: t('exportAiHint'), disabled: selectedRow === null, onClick: () => exportPack(selectedRow === null ? 'latest' : selectedRow.id, { dropFreeText: true }) }, t('exportAiBtn')),
					h('button', { type: 'button', style: S.btn, title: t('exportFullHint'), disabled: selectedRow === null, onClick: () => exportPack(selectedRow === null ? 'latest' : selectedRow.id, { dropFreeText: false }) }, t('exportFullBtn')),
					h('button', { type: 'button', style: S.btn, disabled: selectedRow === null, onClick: () => copyText(JSON.stringify(packPreview(selectedRow === null ? 'latest' : selectedRow.id, {}), null, 2), t('exportPreviewCopy')) }, t('exportPreviewCopy'))),
				h('div', { style: S.buttons },
					h('button', { type: 'button', style: S.btn, title: t('watchExportHint'), disabled: state.watch.incidents.length === 0, onClick: () => exportIncident('latest') }, t('watchExport')),
					h('button', { type: 'button', style: S.btn, title: t('exportJsonHint'), onClick: exportJson }, t('exportJson')),
					h('button', { type: 'button', style: S.btn, title: t('clearHint'), onClick: () => W.__perfHud.clear() }, t('clear'))),
				h('div', { style: S.sub, title: t('storageKeysHint') }, t('storageKeys')),
			];

			// ── 一次只渲染一个视图 ──
			const trend = trendSummary(state.trendMs);
			const devKids = state.devTab === 'dom' ? devDom
				: state.devTab === 'host' ? devHost
					: state.devTab === 'tools' ? devTools
						: state.devTab === 'raw' ? devRaw : devFrames;
			// ⚠️ 三个视图**只在被选中时才构造**:`incidentDetail(detailContext())` 要求"现在真的在
			// 历史上下文里",无条件先算一遍会在实时上下文中拿不到 row 直接抛错(实测过:面板整块不渲染,
			// 离线三套件全绿,只有 check-panel 抓得到)。这里的写法本身也是"没用到的视图不做工"。
			// 两个语义在这里就分开:`latestRow` 给主界面(时间最新),`selectedRow` 给开发者详情
			// (默认最差 / 用户手选)。刻意不共用一个变量 —— 共用就会有人把最差显示成"最近一次"。
			const latestRow = latestIncident();
			const body = h('div', null,
				view === 'main' ? mainView({
					health: healthVerdict(),
					latest: latestRow,
					trendMs: state.trendMs,
					why: state.causeOpen,
					preview: state.packPreview !== null && latestRow !== null && state.packPreview.incident.id === latestRow.id ? state.packPreview : null,
					onOpen: (id) => { setView('incident'); revealIncident(id); },
					onExportPreview: (id) => { openPackPreview(id, { dropFreeText: true }); },
					onExportGo: () => {
						const id = state.packPreviewId;
						closePackPreview();
						exportPack(id, { dropFreeText: true });
					},
					onExportCancel: closePackPreview,
					onWhy: setCauseOpen,
					onRange: setTrendMs,
					onDev: () => setView('dev'),
				}) : null,
				view === 'incident' ? incidentDetail(detailContext()) : null,
				view === 'dev' ? h('div', null, devTabRow({ tab: state.devTab, onTab: setDevTab }), devKids) : null,
				view === 'settings' ? settingsView({
					trend,
					trendMs: state.trendMs,
					onClearIncidents: () => { clearIncidentsNow(); },
					onClearAll: () => { W.__perfHud.clear(); },
				}) : null);

			// 自带边界:渲染抛错时只降级成一块小面板,不让外壳把整个条目停用。
			return h(HudBoundary, { renderError: renderErrorView },
				h('div', { ref: setRoot, id: ROOT_ID, style: { ...S.root(true, panelWidth), ...posStyle, ...dodgeStyle } }, head,
					// 正文是**唯一**的滚动容器:头部(返回 / 设置 / 收起 / 关闭)永远留在原地,
					// 滚轮再长也滚不走它(以前整块一起滚,控件够不着)。
					h('div', { style: S.scroll }, body,
						state.stressNodes > 0 ? h(PerfHudStress, { count: Math.min(state.stressNodes, 6000) }) : null)));
		}
		/** 分享前预览:构建一次存进 state(别每次渲染都重新序列化整份事故包)。 */
		function openPackPreview(id, options) {
			if (id === null || id === undefined) return null;
			const opts = options ?? { dropFreeText: true };
			state.packPreview = packPreview(id, opts);
			state.packPreviewId = id;
			state.packPreviewOptions = opts;
			bump();
			return state.packPreview;
		}
		function closePackPreview() {
			state.packPreview = null;
			state.packPreviewId = null;
			state.packPreviewOptions = null;
			bump();
		}

			return { PerfHud };
		};
		exports.ready = true;
		return exports;
	},
});
