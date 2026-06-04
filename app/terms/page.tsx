import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { ArrowLeft, FileText } from "lucide-react";

export default function TermsOfServicePage() {
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
              <FileText className="w-7 h-7 text-primary" />
              Terms of Service
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Last updated: January 2025
            </p>
          </CardHeader>
          <CardContent className="prose prose-invert prose-sm max-w-none">
            <section className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  1. Acceptance of Terms
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  By accessing and using Trivia Rumble (&quot;the Game&quot;), you accept and
                  agree to be bound by these Terms of Service. If you do not agree to
                  these terms, please do not use the Game.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  2. Description of Service
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  Trivia Rumble is a multiplayer trivia game Discord Activity that allows
                  users to compete in real-time trivia challenges with AI-generated
                  questions. The Game is provided as a free service and requires a Discord
                  account to play.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  3. User Conduct
                </h2>
                <p className="text-muted-foreground leading-relaxed mb-2">
                  When using Trivia Rumble, you agree not to:
                </p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
                  <li>Use cheats, exploits, or automated tools to gain unfair advantages</li>
                  <li>Harass, abuse, or harm other players</li>
                  <li>Attempt to disrupt or interfere with the Game&apos;s functionality</li>
                  <li>Violate Discord&apos;s Terms of Service or Community Guidelines</li>
                  <li>Use the Game for any illegal or unauthorized purpose</li>
                </ul>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  4. Discord Account
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  You must have a valid Discord account to use Trivia Rumble. You are
                  responsible for maintaining the security of your Discord account. We are
                  not responsible for any unauthorized access to your account.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  5. AI-Generated Content
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  Trivia questions in the Game are generated using AI technology. While we
                  strive for accuracy, we cannot guarantee that all questions and answers
                  are completely accurate. The Game is intended for entertainment purposes
                  only.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  6. Intellectual Property
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  All content, features, and functionality of Trivia Rumble, including but
                  not limited to text, graphics, logos, and software, are owned by us or
                  our licensors and are protected by intellectual property laws.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  7. Disclaimer of Warranties
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  Trivia Rumble is provided &quot;as is&quot; and &quot;as available&quot; without any
                  warranties of any kind, either express or implied. We do not warrant
                  that the Game will be uninterrupted, error-free, or free of viruses or
                  other harmful components.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  8. Limitation of Liability
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  In no event shall we be liable for any indirect, incidental, special,
                  consequential, or punitive damages arising out of or relating to your
                  use of the Game. Our total liability shall not exceed the amount you
                  paid to use the Game (which is zero, as the Game is free).
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  9. Termination
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  We reserve the right to terminate or suspend your access to the Game at
                  any time, without prior notice, for any reason, including violation of
                  these Terms of Service.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  10. Changes to Terms
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  We may modify these Terms of Service at any time. We will notify users
                  of any changes by updating the &quot;Last updated&quot; date. Continued use of
                  the Game after changes constitutes acceptance of the modified terms.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  11. Governing Law
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  These Terms of Service shall be governed by and construed in accordance
                  with applicable laws, without regard to conflict of law principles.
                </p>
              </div>

              <div>
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  12. Contact Us
                </h2>
                <p className="text-muted-foreground leading-relaxed">
                  If you have any questions about these Terms of Service, please contact
                  us at:{" "}
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
            href="/privacy"
            className="text-sm text-muted-foreground hover:text-primary transition-colors"
          >
            View Privacy Policy
          </Link>
        </div>
      </div>
    </main>
  );
}
