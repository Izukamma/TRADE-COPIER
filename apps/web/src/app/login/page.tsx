import { LoginForm } from "./form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const { step } = await searchParams;
  return (
    <main className="login">
      <section className="card">
        <div className="brand" style={{ paddingBottom: 12 }}>
          <span className="brand-mark">G</span>
          <span>
            Gabriel <b>Trade Copier</b>
          </span>
        </div>
        <p className="dim" style={{ marginTop: 0 }}>
          Private, single-owner access. There is no public registration.
        </p>
        <LoginForm twoFactor={step === "2fa"} />
      </section>
    </main>
  );
}
