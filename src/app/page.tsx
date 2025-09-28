import HeroChipsToButton from "@/components/HeroChipsToButton";

export default function Home() {
  return (
    <div className="min-h-[300svh] w-full p-6 md:p-10">
      <HeroChipsToButton />
      {/* Placeholder module to accentuate bottom blur */}
      <section className="mt-16 h-[120vh] w-full rounded-[28px] bg-[#E0DED7]"></section>
    </div>
  );
}
