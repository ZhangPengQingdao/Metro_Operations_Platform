/** @type {import('tailwindcss').Config} */
export default {
    darkMode: "class",
    content: [
        "./index.html",
        "./*.{ts,tsx}",
        "./pages/**/*.{ts,tsx}",
        "./components/**/*.{ts,tsx}",
        "./src/**/*.{ts,tsx}",
    ],
    theme: {
        extend: {
            // Theme tokens from index.css, so utilities follow light/dark (opacity modifiers do not apply to these).
            colors: {
                paper: "var(--afc-color-paper)",
                canvas: "var(--afc-color-canvas)",
                soft: "var(--afc-color-neutral-soft)",
                hover: "var(--afc-control-hover)",
                ink: "var(--afc-color-ink)",
                muted: "var(--afc-color-muted)",
                placeholder: "var(--afc-placeholder)",
                line: "var(--afc-color-line)",
                strong: "var(--afc-interactive-border)",
                accent: "var(--afc-color-primary)",
                "accent-hover": "var(--afc-color-primary-hover)",
                "accent-soft": "var(--afc-color-primary-soft)",
                "accent-ink": "var(--afc-color-primary-ink)",
                "on-accent": "var(--afc-on-primary)",
            },
            fontFamily: {
                sans: ["Noto Sans SC", "PingFang SC", "Microsoft YaHei", "sans-serif"],
                display: ["Noto Sans SC", "PingFang SC", "Microsoft YaHei", "sans-serif"],
                numeric: ["Manrope", "Noto Sans SC", "sans-serif"],
            },
        },
    },
    plugins: [
        require("@tailwindcss/forms"),
        require("@tailwindcss/container-queries"),
    ],
}
