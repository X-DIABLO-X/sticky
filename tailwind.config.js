/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        clicky: {
          50: "#eef7ff",
          100: "#d9ecff",
          200: "#bcddff",
          300: "#8ec6ff",
          400: "#58a3ff",
          500: "#3186ff",
          600: "#1a66f5",
          700: "#134fe1",
          800: "#1640b6",
          900: "#18398e",
          950: "#112456",
        },
        cyber: {
          dark: "#0b0f17",
          panel: "#111827cc",
          card: "#1f293799",
          border: "#37415180",
          glow: "#38bdf8",
        },
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "pulse-glow": "pulseGlow 2s ease-in-out infinite",
        "border-glow": "borderGlow 2.5s ease-in-out infinite",
        "float": "float 3s ease-in-out infinite",
      },
      keyframes: {
        pulseGlow: {
          "0%, 100%": {
            boxShadow: "0 0 15px rgba(56, 189, 248, 0.4), 0 0 30px rgba(49, 134, 255, 0.2)",
          },
          "50%": {
            boxShadow: "0 0 25px rgba(56, 189, 248, 0.8), 0 0 50px rgba(49, 134, 255, 0.4)",
          },
        },
        borderGlow: {
          "0%, 100%": {
            borderColor: "rgba(56, 189, 248, 0.8)",
            boxShadow: "inset 0 0 15px rgba(56, 189, 248, 0.3), 0 0 20px rgba(56, 189, 248, 0.4)",
          },
          "50%": {
            borderColor: "rgba(168, 85, 247, 0.8)",
            boxShadow: "inset 0 0 15px rgba(168, 85, 247, 0.3), 0 0 20px rgba(168, 85, 247, 0.4)",
          },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-4px)" },
        },
      },
      backdropBlur: {
        xs: "2px",
      },
    },
  },
  plugins: [],
};
