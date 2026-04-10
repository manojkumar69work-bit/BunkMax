export default function AboutPage() {
  return (
    <div className="app-shell space-y-4">
      {/* ABOUT */}
      <div className="glass-card p-5 space-y-3">
        <h1 className="text-2xl font-bold">About BunkMax</h1>

        <p className="text-sm text-gray-300 leading-relaxed">
          BunkMax is a smart attendance companion designed for students to track
          classes, plan bunks strategically, and recover attendance without
          stress. With real-time insights and predictive analysis, it shows
          exactly how your attendance changes, helping you stay in control and
          avoid surprises at the end of the semester.
        </p>
      </div>

      {/* FEATURES */}
      <div className="glass-card p-5 space-y-3">
        <h2 className="text-lg font-semibold">What You Can Do</h2>

        <ul className="text-sm text-gray-300 space-y-2">
          <li>• Track subject-wise and overall attendance</li>
          <li>• Plan safe bunks with smart predictions</li>
          <li>• Know best & worst days to skip</li>
          <li>• Recover attendance with accurate calculations</li>
          <li>• Avoid last-minute attendance shocks</li>
        </ul>
      </div>

      {/* CONTACT */}
      <div className="glass-card p-5 space-y-3">
        <h2 className="text-lg font-semibold">Contact Us</h2>

        <p className="text-sm text-gray-400">
          Have feedback, suggestions, or found a bug? Reach out 👇
        </p>

        <div className="space-y-2 text-sm">
          <a
            href="mailto:yourgmail@gmail.com"
            className="block rounded-lg border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/10 transition"
          >
            📧 Gmail: yourgmail@gmail.com
          </a>

          <a
            href="https://instagram.com/yourusername"
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-lg border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/10 transition"
          >
            📸 Instagram: @yourusername
          </a>
        </div>
      </div>

      {/* FOOTER */}
      <div className="text-center text-xs text-gray-500 pt-2">
        Built with ❤️ for students from spidy
      </div>
    </div>
  );
}