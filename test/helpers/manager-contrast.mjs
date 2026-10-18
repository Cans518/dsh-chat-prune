// Playwright executes this callback in the page, so it must be self-contained.
export function measureManagerContrast(element) {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  function luminance(color) {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
      const channel = value / 255
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
    })
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
  }
  function contrast(foreground, background) {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
    return (values[0] + .05) / (values[1] + .05)
  }
  const row = element.querySelector('[data-selected="true"]')
  const primary = getComputedStyle(element.querySelector('.dshdc-operation-bar .dshdc-primary'))
  const quickFilter = getComputedStyle(element.querySelector('.dshdc-status-filter[aria-pressed="true"]'))
  const badge = getComputedStyle(element.querySelector('.dshdc-badge[data-kind="pinned"],.dshdc-badge[data-kind="idle"]'))
  return {
    body: contrast(getComputedStyle(row.querySelector('strong')).color, getComputedStyle(row).backgroundColor),
    secondary: contrast(getComputedStyle(row.querySelector('.dshdc-record-meta')).color, getComputedStyle(row).backgroundColor),
    primary: contrast(primary.color, primary.backgroundColor),
    quickFilter: contrast(quickFilter.color, quickFilter.backgroundColor),
    badge: contrast(badge.color, badge.backgroundColor),
  }
}
