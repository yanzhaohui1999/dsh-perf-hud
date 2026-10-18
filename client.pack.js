/**
 * dsh-perf-hud 的包内分片(package-local chunk):zip 打包。
 *
 * 加载方:`client.js` 的 `PerfHudGate` 用 `require.async('./client.pack.js')`。
 * 注册约定来自 DSH 的 `@deepseek-ai/dsh-client-modules`:
 *   - 文件名必须是 `client.<suffix>.js`(宿主只服务这个形状,见 `CLIENT_CHUNK`);
 *   - `chunk` 字段写文件名,`id` 仍写包名;加载器按 `<包名>/<文件名>` 记 factory;
 *   - 脚本执行即注册,`factory(require)` 的返回值就是 `require.async` 的 exports。
 *
 * 为什么先搬 zip:它是这一层里**唯一无外部依赖**的一段(纯函数,不碰 state /
 * translate / DOM),搬完就能用离线套件的 CRC32 / 字节向量直接对拍。诊断包的
 * `manifestFor` / `buildPack` 依赖二十来个主文件函数,下一批再搬。
 */
window.__ModuleLoader__.load({
	id: 'dsh-perf-hud',
	chunk: 'client.pack.js',
	factory: (require) => {
		const exports = {};

		/**
		 * 标准 CRC-32(IEEE 802.3):`'123456789'` → 0xCBF43926,有断言钉住。
		 * 用逐位算法而不是 256 项查表:一次打包只调用 4 次,现算换掉一份模块级状态更划算。
		 */
		function crc32(bytes) {
			let crc = -1;
			for (let i = 0; i < bytes.length; i += 1) {
				crc ^= bytes[i];
				for (let k = 0; k < 8; k += 1) crc = (crc & 1) !== 0 ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
			}
			return (crc ^ -1) >>> 0;
		}

		function utf8Bytes(text) {
			return new TextEncoder().encode(String(text));
		}

		/** zip 要的是 DOS 时间戳(两个 16 位字段),不是 ISO 串。 */
		function dosStamp(atMs) {
			const date = new Date(typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : Date.now());
			const year = Math.max(1980, date.getFullYear());
			return {
				time: ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xFFFF,
				date: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF,
			};
		}

		/** `files` = `[{ name, text }]` → zip 的字节(store,不压缩)。 */
		function zipStore(files, atMs) {
			const stamp = dosStamp(atMs);
			const parts = [];
			const central = [];
			let offset = 0;
			for (const file of files) {
				const name = utf8Bytes(file.name);
				const data = utf8Bytes(file.text);
				const crc = crc32(data);
				const local = new Uint8Array(30 + name.length);
				const lv = new DataView(local.buffer);
				lv.setUint32(0, 0x04034B50, true);      // 本地文件头签名
				lv.setUint16(4, 20, true);              // version needed to extract
				lv.setUint16(6, 0x0800, true);          // 文件名是 UTF-8
				lv.setUint16(8, 0, true);               // 0 = store
				lv.setUint16(10, stamp.time, true);
				lv.setUint16(12, stamp.date, true);
				lv.setUint32(14, crc, true);
				lv.setUint32(18, data.length, true);    // 压缩后大小 = 原始大小(store)
				lv.setUint32(22, data.length, true);
				lv.setUint16(26, name.length, true);
				lv.setUint16(28, 0, true);              // extra 长度
				local.set(name, 30);
				parts.push(local, data);
				const dir = new Uint8Array(46 + name.length);
				const dv = new DataView(dir.buffer);
				dv.setUint32(0, 0x02014B50, true);      // 中央目录签名
				dv.setUint16(4, 20, true);              // version made by
				dv.setUint16(6, 20, true);
				dv.setUint16(8, 0x0800, true);
				dv.setUint16(10, 0, true);
				dv.setUint16(12, stamp.time, true);
				dv.setUint16(14, stamp.date, true);
				dv.setUint32(16, crc, true);
				dv.setUint32(20, data.length, true);
				dv.setUint32(24, data.length, true);
				dv.setUint16(28, name.length, true);
				dv.setUint16(30, 0, true);              // extra
				dv.setUint16(32, 0, true);              // comment
				dv.setUint16(34, 0, true);              // disk number
				dv.setUint16(36, 0, true);              // internal attrs
				dv.setUint32(38, 0, true);              // external attrs
				dv.setUint32(42, offset, true);         // 本地头偏移
				dir.set(name, 46);
				central.push(dir);
				offset += local.length + data.length;
			}
			let centralSize = 0;
			for (const dir of central) centralSize += dir.length;
			const eocd = new Uint8Array(22);
			const ev = new DataView(eocd.buffer);
			ev.setUint32(0, 0x06054B50, true);          // EOCD 签名
			ev.setUint16(4, 0, true);
			ev.setUint16(6, 0, true);
			ev.setUint16(8, files.length, true);
			ev.setUint16(10, files.length, true);
			ev.setUint32(12, centralSize, true);
			ev.setUint32(16, offset, true);             // 中央目录起始偏移
			ev.setUint16(20, 0, true);                  // 注释长度
			const all = [...parts, ...central, eocd];
			let total = 0;
			for (const part of all) total += part.length;
			const out = new Uint8Array(total);
			let at = 0;
			for (const part of all) { out.set(part, at); at += part.length; }
			return out;
		}

		/** zip 字节 → base64:给验收器用(CDP 里传字节数组太笨重)。分块,避免 apply 爆栈。 */
		function zipBase64(bytes) {
			let text = '';
			const CHUNK = 0x8000;
			for (let at = 0; at < bytes.length; at += CHUNK) {
				text += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
			}
			return btoa(text);
		}

		exports.crc32 = crc32;
		exports.utf8Bytes = utf8Bytes;
		exports.dosStamp = dosStamp;
		exports.zipStore = zipStore;
		exports.zipBase64 = zipBase64;
		exports.ready = true;
		exports.version = 1;
		return exports;
	},
});
