import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — Design Matcher",
  description: "Privacy policy for Design Matcher tile matching service.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="max-w-2xl mx-auto px-6 py-16">
        <Link href="/" className="text-neutral-500 hover:text-neutral-300 text-sm mb-10 inline-block transition-colors">
          ← Back
        </Link>

        <h1 className="text-3xl font-semibold mb-2">Privacy Policy</h1>
        <p className="text-neutral-500 text-sm mb-12">Design Matcher · Last updated: June 2026</p>

        <div className="space-y-10">
          <section>
            <h2 className="text-lg font-medium mb-3">What we collect</h2>
            <p className="text-neutral-400 leading-relaxed">
              When you connect your Pinterest account, we access your board names, board cover images,
              and pin images and descriptions in order to display your boards and pins within the app.
              We also process inspiration images you submit for tile matching.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">How we use it</h2>
            <p className="text-neutral-400 leading-relaxed">
              Pinterest data and uploaded images are used solely to match your inspiration against local
              tile supplier catalogs. We do not store your Pinterest data permanently and do not share
              it with any third parties.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">Pinterest data</h2>
            <p className="text-neutral-400 leading-relaxed">
              We access your boards and pins read-only via the Pinterest API. We never post, modify,
              or delete any of your Pinterest content. Pinterest connection is optional — the tile
              matching feature works without it.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">Tile search data</h2>
            <p className="text-neutral-400 leading-relaxed">
              Search images and matching results may be logged to improve the quality of tile
              recommendations over time. No personally identifiable information is attached to these logs.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">Scope</h2>
            <p className="text-neutral-400 leading-relaxed">
              This policy applies to{" "}
              <span className="text-neutral-300">designmatcher.vercel.app</span> and any associated
              API endpoints.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-medium mb-3">Contact</h2>
            <p className="text-neutral-400 leading-relaxed">
              Questions about this policy?{" "}
              <a
                href="mailto:afrankdawson@gmail.com"
                className="text-neutral-300 hover:text-white underline underline-offset-2 transition-colors"
              >
                afrankdawson@gmail.com
              </a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
