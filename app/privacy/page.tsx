import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { ArrowLeft, Shield } from "lucide-react";

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Game
        </Link>

        <Card className="border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-3 text-2xl">
              <Shield className="w-7 h-7 text-primary" />
              Privacy Policy
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Last updated: January 2025
            </p>
          </CardHeader>
          <CardContent className="prose prose-invert prose-sm max-w-none">
            <section className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  1. Introduction
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  Welcome to Trivia Rumble (&quot;the Game&quot;). This Privacy Policy explains how we
                  collect, use, and protect your information when you use our Discord
                  Activity. By using Trivia Rumble, you agree to the collection and use of
                  information in accordance with this policy.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  2. Information We Collect
                </h2>
                <p className="text-muted-foreground leading-relaxed mb-2">
                  When you use Trivia Rumble, we collect the following information through
                  the Discord API:
                </p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
                  <li>Discord User ID</li>
                  <li>Discord Username and Display Name</li>
                  <li>Discord Avatar URL</li>
                  <li>Game session data (scores, answers, room participation)</li>
                </ul>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  3. How We Use Your Information
                </h2>
                <p className="text-muted-foreground leading-relaxed mb-2">
                  We use the collected information to:
                </p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
                  <li>Identify you within game sessions</li>
                  <li>Display your username and avatar to other players</li>
                  <li>Track game scores and progress during sessions</li>
                  <li>Provide multiplayer functionality</li>
                </ul>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  4. Data Storage
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  Game session data is stored temporarily in Firebase Realtime Database
                  for the duration of game sessions. This data is automatically deleted
                  when game rooms expire or are closed. We do not permanently store your
                  Discord information or game history beyond active sessions.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  5. Data Sharing
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  We do not sell, trade, or otherwise transfer your personal information
                  to third parties. Your information is only shared with other players in
                  the same game room for the purpose of gameplay.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  6. Third-Party Services
                </h2>
                <p className="text-muted-foreground leading-relaxed mb-2">
                  Trivia Rumble uses the following third-party services:
                </p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
                  <li>Discord API - For authentication and user data</li>
                  <li>Firebase Realtime Database - For game session storage</li>
                  <li>Groq AI - For trivia question generation</li>
                </ul>
                <p className="text-muted-foreground leading-relaxed mt-2">
                  Each of these services has their own privacy policies governing their
                  use of data.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  7. Children&apos;s Privacy
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  Trivia Rumble is not intended for children under 13 years of age. We do
                  not knowingly collect personal information from children under 13. If
                  you are a parent or guardian and believe your child has provided us
                  with personal information, please contact us.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  8. Your Rights
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  You have the right to request deletion of your data. Since we only
                  store temporary session data, this data is automatically deleted when
                  sessions end. For any concerns or requests regarding your data, please
                  contact us.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  9. Changes to This Policy
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  We may update this Privacy Policy from time to time. We will notify
                  users of any changes by updating the &quot;Last updated&quot; date at the top of
                  this page.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  10. Contact Us
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  If you have any questions about this Privacy Policy, please contact us
                  at:{" "}
                  <a
                    href="mailto:walusimbileon6@gmail.com"
                    className="text-primary hover:underline"
                  >
                    walusimbileon6@gmail.com
                  </a>
                </p>
              </div>
            </section>
          </CardContent>
        </Card>

        <div className="mt-6 text-center">
          <Link
            href="/terms"
            className="text-sm text-muted-foreground hover:text-primary transition-colors"
          >
            View Terms of Service
          </Link>
        </div>
      </div>
    </main>
  );
}
