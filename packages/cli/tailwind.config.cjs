/** Tailwind config for the built-in dashboard (`launchpad dashboard`) only. */
module.exports = {
  content: ["./src/dashboard/**/*.{tsx,ts}"],
  theme: {
    extend: {},
  },
  daisyui: {
    themes: ["night"],
  },
  plugins: [require("daisyui")],
};
