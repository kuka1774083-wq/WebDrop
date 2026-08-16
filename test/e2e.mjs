// E2E 冒烟测试（需真实浏览器；本机可用 Edge）
// 运行：node test/e2e.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pw = null;
try {
  pw = require('playwright');
} catch {
  pw = require('C:/Users/libin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
}
const { chromium } = pw;

const BASE = process.env.WEBDROP_URL || 'http://127.0.0.1:8080';
const results = [];
const check = (name, cond) => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}`);
  if (!cond) process.exitCode = 1;
};

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const ctxA = await browser.newContext({ acceptDownloads: true });
    const ctxB = await browser.newContext({ acceptDownloads: true });
    const ctxC = await browser.newContext({ acceptDownloads: true });
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    const C = await ctxC.newPage();
    A.on('dialog', (d) => d.accept());
    for (const p of [A, B, C]) {
      p.on('pageerror', (e) => console.error('[pageerror]', e.message));
      p.on('console', (m) => {
        if (m.type() === 'error') console.error('[console.error]', m.text());
      });
    }

    await A.goto(BASE);
    await B.goto(BASE);

    // 两个临时用户同时在线
    await A.waitForSelector('.user-item', { timeout: 10000 });
    await B.waitForSelector('.user-item', { timeout: 10000 });
    const names = await A.$$eval('.user-item .name', (els) => els.map((e) => e.textContent));
    await B.waitForFunction(() => document.querySelector('.my-name')?.textContent !== '连接中…', null, { timeout: 8000 });
    const bName = await B.$eval('.my-name', (e) => e.textContent);
    await A.waitForFunction(() => document.querySelector('.my-name')?.textContent !== '连接中…', null, { timeout: 8000 });
    const aName = await A.$eval('.my-name', (e) => e.textContent);
    check('A 看到 B 在线', names.includes(bName));

    // A 点击 B → B 收到请求并接受
    await A.evaluate((id) => {
      const item = [...document.querySelectorAll('.user-item')].find((x) => x.querySelector('.name')?.textContent === id);
      if (!item) throw new Error('目标用户不在线: ' + id);
      item.click();
    }, bName);
    await B.waitForSelector('.request-item button.ok', { timeout: 10000 });
    await B.click('.request-item button.ok');

    // 文本消息
    await A.waitForSelector('.chat-only-wrap .chat-input input[type=text]:enabled', { timeout: 10000 });
    await A.fill('.chat-input input[type=text]', '你好，这是文本测试');
    await A.click('.chat-input .btn');
    await B.waitForSelector('.msg.theirs', { timeout: 8000 });
    const text = await B.$eval('.msg.theirs', (e) => e.textContent);
    check('B 收到 A 的文本消息', text.includes('你好，这是文本测试'));
    check('消息旁显示发送时间', /^\d{2}:\d{2}$/.test(await B.$eval('.msg.theirs .msg-time', (e) => e.textContent)));

    // 小文件（<10M）走服务器暂存
    await A.setInputFiles('.chat-input input[type=file]', {
      name: 'hello-e2e.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello webdrop e2e ' + 'x'.repeat(1024)),
    });
    await B.waitForSelector('.msg .file-chip', { timeout: 12000 });
    const chip = await B.$eval('.msg .file-chip', (e) => e.textContent);
    check('B 收到暂存文件气泡', chip.includes('hello-e2e.txt'));

    // 大文件（>10M）：接收后直接下载，校验内容完整性
    const { createHash } = await import('node:crypto');
    const big = Buffer.alloc(11 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const expectedHash = createHash('sha256').update(big).digest('hex');
    const dlPromise = B.waitForEvent('download', { timeout: 30000 });
    await A.setInputFiles('.chat-input input[type=file]', {
      name: 'big-e2e.bin',
      mimeType: 'application/octet-stream',
      buffer: big,
    });
    await B.waitForSelector('.modal', { timeout: 10000 });
    await B.click('.modal .actions .btn.ok');
    await B.waitForFunction(() => !document.querySelector('#modal-root.open'), null, { timeout: 5000 });
    check('接收弹窗正常关闭（直接下载）', true);
    const download = await dlPromise;
    const stream = await download.createReadStream();
    const recv = [];
    for await (const c of stream) recv.push(c);
    const receivedHash = createHash('sha256').update(Buffer.concat(recv)).digest('hex');
    check('大文件传输内容完整（SHA-256 一致）', receivedHash === expectedHash);
    await A.waitForFunction(() => {
      return [...document.querySelectorAll('.chat-body .msg')].some((e) => e.textContent.includes('big-e2e.bin') && e.textContent.includes('已发送'));
    }, null, { timeout: 30000 });
    check('大文件传输完成', true);

    // 取消大文件传输（对方未接收前发送方取消）
    await A.setInputFiles('.chat-input input[type=file]', {
      name: 'cancel-me.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(12 * 1024 * 1024, 9),
    });
    await B.waitForSelector('.modal', { timeout: 10000 });
    await A.waitForSelector('.cancel-transfer', { timeout: 8000 });
    await A.click('.cancel-transfer');
    await B.waitForFunction(() => !document.querySelector('#modal-root.open'), null, { timeout: 5000 });
    check('发送方取消后接收弹窗关闭', true);
    const cancelText = await A.textContent('.chat-body');
    check('发送方显示已取消', cancelText.includes('已取消'));

    // 本机昵称醒目展示（临时用户自动分配趣味昵称）；右上角恢复显示登录/注册
    check('本机显示自动分配的昵称', aName.length >= 4 && !aName.includes('TEMP'));
    check('右上角显示登录/注册而非昵称', (await A.textContent('#nav-user')).includes('登录'));

    // 连接建立后只显示聊天框
    check('连接后 A 隐藏在线用户列表', (await A.$('.home-layout')) === null);
    check('连接后 A 显示聊天框', (await A.$('.chat-input')) !== null);
    await A.waitForFunction(() => document.querySelector('.chat-body')?.textContent.includes('同一局域网'), null, { timeout: 10000 });
    check('同局域网检测并提示', true);

    // 第三方看到两人繁忙且无法发起请求
    await C.goto(BASE);
    await C.waitForSelector('.user-item.busy', { timeout: 10000 });
    const busyNames = await C.$$eval('.user-item.busy .name', (els) => els.map((e) => e.textContent));
    check('第三方看到 B 繁忙', busyNames.includes(bName));
    await C.evaluate((id) => {
      const item = [...document.querySelectorAll('.user-item')].find((x) => x.querySelector('.name')?.textContent === id);
      item.click();
    }, bName);
    await C.waitForSelector('.toast', { timeout: 5000 });
    const toastText = await C.textContent('.toast');
    check('繁忙用户无法被请求', toastText.includes('正忙'));

    // A 结束会话 → 双方回到列表，C 可再次发起
    await A.click('.chat-head button');
    await A.waitForSelector('.modal .actions .btn.danger', { timeout: 5000 });
    await A.click('.modal .actions .btn.danger');
    await B.waitForSelector('.request-panel', { timeout: 8000 });
    await C.waitForFunction((name) => {
      const item = [...document.querySelectorAll('.user-item')].find((x) => x.querySelector('.name')?.textContent === name);
      return !item || !item.classList.contains('busy');
    }, aName, { timeout: 8000 });
    check('结束会话后 B 回到空闲界面', (await B.$('.chat-input')) === null);
    await C.evaluate((id) => {
      const item = [...document.querySelectorAll('.user-item')].find((x) => x.querySelector('.name')?.textContent === id);
      item.click();
    }, aName);
    await A.waitForSelector('.request-item', { timeout: 8000 });
    check('空闲后 C 可向 A 发起请求', true);

    // 临时用户注销：UUID 释放、页面重新分配临时身份
    const oldName = aName;
    const oldTemp = await A.evaluate(() => localStorage.getItem('wd_temp'));
    await A.click('.my-banner .btn.danger');
    await A.waitForSelector('.modal .actions .btn.danger', { timeout: 5000 });
    await A.click('.modal .actions .btn.danger');
    await A.waitForFunction((old) => localStorage.getItem('wd_temp') !== old, oldTemp, { timeout: 10000 });
    await A.waitForFunction(() => {
      const t = document.querySelector('.my-name')?.textContent || '';
      return t && t !== '连接中…';
    }, null, { timeout: 8000 });
    const newName = await A.$eval('.my-name', (e) => e.textContent);
    check('注销后分配新的临时昵称', newName !== oldName && newName.length >= 4);
    check('注销后右上角仍为登录/注册', (await A.textContent('#nav-user')).includes('登录'));

    // 同一浏览器多开：后开窗口提示不支持多开
    const A2 = await ctxA.newPage();
    await A2.goto(BASE);
    await A2.waitForSelector('#multi-open', { timeout: 10000 });
    check('后开窗口提示本页面不支持多开', (await A2.textContent('#multi-open')).includes('不支持多开'));
    check('原窗口未受影响', (await A.textContent('.my-name')).length >= 4);
    await A2.close();

    // 移动端（窄屏）：请求收进闪烁按钮，点击展开弹窗
    await C.setViewportSize({ width: 390, height: 844 });
    await C.goto(BASE);
    await C.waitForSelector('.user-item', { timeout: 10000 });
    await C.waitForFunction(() => document.querySelector('.my-name')?.textContent !== '连接中…', null, { timeout: 8000 });
    const cName = await C.$eval('.my-name', (e) => e.textContent);
    await A.evaluate((id) => {
      const item = [...document.querySelectorAll('.user-item')].find((x) => x.querySelector('.name')?.textContent === id);
      if (!item) throw new Error('目标不在线: ' + id);
      item.click();
    }, cName);
    await C.waitForSelector('.request-alert.has-req', { timeout: 10000 });
    check('移动端收到请求显示闪烁按钮', true);
    await C.click('.request-alert.has-req');
    await C.waitForSelector('.modal .request-item button.ok', { timeout: 8000 });
    check('移动端点击按钮展开请求弹窗', true);
    await C.click('.modal .request-item button.secondary');
    await C.waitForFunction(() => !document.querySelector('#modal-root.open'), null, { timeout: 5000 });

    // 管理员登录（兼容已改密状态）→ 首次登录强制改密 → 进入管理台
    const doLogin = async (u, p) => {
      await C.goto(BASE + '/#/login');
      await C.fill('form input[name=username]', u);
      await C.fill('form input[name=password]', p);
      await C.click('form button[type=submit]');
      await C.waitForTimeout(1200);
    };
    await doLogin('admin', 'admin');
    let changeForm = await C.$('h2:has-text("首次登录")');
    if (changeForm) {
      await C.fill('form input[name=username]', 'root');
      await C.fill('form input[name=password]', 'root123');
      await C.click('form button[type=submit]');
      check('管理员首次登录强制改密', true);
    } else if (!C.url().includes('admin')) {
      await doLogin('root', 'root123');
    }
    await C.waitForSelector('.tabs .tab', { timeout: 8000 });
    check('管理员登录后直接进入管理台', (await C.textContent('.tabs')).includes('仪表盘'));
    const navVisible = await C.$$eval('#nav a:not(.hidden)', (els) => els.map((e) => e.textContent));
    check('管理员导航不含点对点/房间', !navVisible.some((t) => t.includes('点对点') || t.includes('房间')));

    // 管理台文件管理能看到 P2P 暂存文件
    await C.click('.tab:has-text("文件管理")');
    await C.waitForSelector('select', { timeout: 8000 });
    // 默认只显示未删除文件；暂存文件会话结束已删除，切到全部状态查看
    await C.locator('select').nth(1).selectOption('all');
    await C.waitForSelector('table td', { timeout: 8000 });
    const adminFiles = await C.textContent('table');
    check('管理台可见暂存文件记录', adminFiles.includes('hello-e2e.txt'));

    // 普通用户路由无法进入管理台
    await A.goto(BASE + '/#/admin');
    await A.waitForTimeout(600);
    check('普通用户访问管理台被重定向', !A.url().includes('/admin'));
  } finally {
    await browser.close();
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\nE2E 结果：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
