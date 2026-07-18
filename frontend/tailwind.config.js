/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Brand palette (from the design spec).
        "charcoal-blue": "#394053",
        charcoal: "#4e4a59",
        "taupe-grey": "#6e6362",
        "dusty-olive": "#839073",
        sage: "#7cae7a",
        // Theme-aware semantic tokens (values come from CSS vars in globals.css so the
        // same class works in light and dark mode).
        app: "rgb(var(--app-bg) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        "panel-2": "rgb(var(--panel-2) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        "ink-muted": "rgb(var(--ink-muted) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-ink": "rgb(var(--accent-ink) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};
