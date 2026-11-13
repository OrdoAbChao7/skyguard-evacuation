/**
 * 来源 URL 可达性核验（不替代人工作者/许可证核验）。
 *
 *   tsx scripts/verify-sources.ts
 *
 * 输出 evaluation/v62/source_verification.json，并追加到 research/SOURCE_AUDIT.md。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SOURCES = path.join(ROOT, 'research/SOURCES.jsonl');
const OUT = path.join(ROOT, 'evaluation/v62/source_verification.json');
const AUDIT = path.join(ROOT, 'research/SOURCE_AUDIT.md');

const rows = fs.readFileSync(SOURCES, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(line => JSON.parse(line));

function titleOf(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim().slice(0, 180) : null;
}

async function check(source: any): Promise<any> {
  const started = Date.now();
  try {
    const response = await fetch(source.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'SkyGuard-source-audit/1.0 (+research verification)' },
    });
    const type = response.headers.get('content-type') ?? '';
    let title: string | null = null;
    if (type.includes('text/html') || type.includes('text/plain')) {
      const text = (await response.text()).slice(0, 200_000);
      title = titleOf(text);
    } else {
      await response.body?.cancel();
    }
    return {
      id: source.id,
      url: source.url,
      final_url: response.url,
      status: response.status,
      reachable: response.ok || (response.status >= 300 && response.status < 400),
      content_type: type,
      title,
      duration_ms: Date.now() - started,
      error: null,
    };
  } catch (error) {
    return {
      id: source.id,
      url: source.url,
      final_url: null,
      status: null,
      reachable: false,
      content_type: null,
      title: null,
      duration_ms: Date.now() - started,
      error: (error as Error).message,
    };
  }
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: size }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
const results = await pool(rows, 6, check);
const summary = {
  generated_at: new Date().toISOString(),
  total: results.length,
  reachable: results.filter(item => item.reachable).length,
  unreachable: results.filter(item => !item.reachable).length,
  errors: results.filter(item => item.error).length,
  note: '本检查只验证 URL 可达性与页面 title；作者、年份、许可证与“是否支持主张”仍需人工核验。',
  results,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);

const lines = [
  '',
  `## V6.2 URL 可达性核验（${summary.generated_at}）`,
  '',
  `- 总来源：${summary.total}；可达：${summary.reachable}；不可达：${summary.unreachable}；请求错误：${summary.errors}`,
  '- 仅验证 URL 与页面 title；作者、年份、许可证、是否支持主张仍为人工待核验项。',
  '',
  '| ID | 状态 | HTTP | 标题 | URL |',
  '| --- | --- | --- | --- | --- |',
  ...results.map(item => `| ${item.id} | ${item.reachable ? '可达' : '不可达/错误'} | ${item.status ?? '—'} | ${(item.title ?? item.error ?? '—').replaceAll('|', '\\|').slice(0, 100)} | ${item.url} |`),
];
fs.appendFileSync(AUDIT, `${lines.join('\n')}\n`);
console.log(`[sources] ${summary.reachable}/${summary.total} reachable; ${summary.unreachable} unreachable`);
}

void main().catch(error => { console.error(error); process.exit(1); });
