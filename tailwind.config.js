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
            colors: {
                primary: "#10B981", // Emerald 500
                "primary-dark": "#059669",
                "background-light": "#F9FAFB",
                "text-main": "#111827",
                "text-muted": "#6B7280",
                "border-light": "#E5E7EB",
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
