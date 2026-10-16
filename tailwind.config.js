/** Konfigurimi i Tailwind CSS për Lokali.
 *  Ngjyrat lidhen me variablat CSS në assets/css/style.css,
 *  kështu që tema e çelët/e errët punon automatikisht. */
module.exports = {
  content: ['./index.html', './assets/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)', surface: 'var(--surface)', surface2: 'var(--surface-2)',
        ink: 'var(--ink)', muted: 'var(--muted)', line: 'var(--line)',
        accent: 'var(--accent)', ok: 'var(--ok)', info: 'var(--info)', bad: 'var(--bad)'
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['"Instrument Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      }
    }
  }
};
