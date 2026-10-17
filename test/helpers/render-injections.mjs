/**
 * Test-owned HTML fixture for this plugin's inline body-script contract.
 * The real host renderer is exercised separately by host-e2e.mjs.
 */
export function renderFixtureInjections(html, rows) {
  const scripts = rows.map((row) => {
    if (row.kind !== 'script' || row.placement !== 'body' || typeof row.text !== 'string') {
      throw new Error('Unsupported injection in the test fixture')
    }
    return `<script>${row.text.replace(/<\/script/gi, '<\\/script')}</script>`
  }).join('\n')
  if (!html.includes('</body>')) throw new Error('Fixture HTML requires a closing body tag')
  return html.replace('</body>', () => `${scripts}</body>`)
}
