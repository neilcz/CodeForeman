import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://localhost:3780/login');
await page.fill('input[placeholder="用户名"]', 'admin');
await page.fill('input[placeholder="密码"]', 'admin');
await page.click('button:has-text("登")');
await page.waitForURL('**/projects', { timeout: 10000 });
await page.click('.ant-menu-item:has-text("计划")');
await page.waitForTimeout(1200);

await page.click('button:has-text("添加计划")');
await page.waitForTimeout(600);
await page.click('.ant-modal .ant-select');
await page.waitForTimeout(300);
await page.locator('.ant-select-item-option').first().click();
await page.fill('.ant-modal input[placeholder="一句话说清要做什么"]', '草稿持久化测试计划');
await page.fill('.ant-modal textarea', '这是描述内容，关闭后重开应保留');
await page.click('.ant-modal-close'); // 关闭弹窗（不提交）
await page.waitForTimeout(500);

await page.click('button:has-text("添加计划")');
await page.waitForTimeout(600);
const title = await page.inputValue('.ant-modal input[placeholder="一句话说清要做什么"]');
const desc = await page.inputValue('.ant-modal textarea');
console.log('草稿恢复:', title === '草稿持久化测试计划' && desc.includes('关闭后重开应保留') ? '✓ PASS' : `✗ FAIL title="${title}"`);
const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cf_task_draft')));
console.log('账号隔离 key:', keys.join(','), keys[0]?.endsWith('_admin') ? '✓ PASS' : '✗ FAIL');

// 提交后草稿应清空
await page.click('.ant-modal button:has-text("加入队列")');
await page.waitForTimeout(1200);
const after = await page.evaluate(() => localStorage.getItem('cf_task_draft_admin'));
console.log('提交后草稿清空:', after === null ? '✓ PASS' : `✗ FAIL ${after}`);
await page.screenshot({ path: '/tmp/cf-backlog.png' });
await browser.close();
