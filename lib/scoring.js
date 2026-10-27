// Arzoom Avto lizinq skorinqi. Eyni fayl serverdə (require) və əməkdaş panelində (<script>) işləyir.
// Qaydalar ilkin versiyadır: risk siyasəti təsdiqlənəndə həddləri burada dəyiş.
(function (root) {
  const POLICY = {
    maxDti: 0.5,          // ümumi aylıq borc yükü / xalis gəlir
    stopDti: 0.6,         // bundan yuxarı avtomatik imtina tövsiyəsi
    minTenureMonths: 6,
    minDownPct: 10
  };
  const OVERDUE = { "0": 0, "1-30": 10, "31-90": 30, "90+": 100 };

  const pmt = (F, rate, n) => {
    const r = rate / 100 / 12;
    return r ? F * r / (1 - Math.pow(1 + r, -n)) : F / n;
  };

  // i: { incomeMonthly, debtMonthly, activeLoans, overdueNow, maxOverdue, tenureMonths, docsOk,
  //      price, downPct, months, rate }
  function assess(i) {
    const n = k => Math.max(0, +i[k] || 0);
    const income = n("incomeMonthly"), debt = n("debtMonthly"), price = n("price");
    const downPct = n("downPct"), months = n("months") || 36, rate = n("rate");
    const F = price * (1 - downPct / 100);
    const pay = price ? pmt(F, rate, months) : 0;
    const dti = income ? (debt + pay) / income : Infinity;
    const stops = [], notes = [];
    let score = 100;

    if (i.overdueNow) stops.push("Hazırda aktiv gecikmə var");
    if (i.maxOverdue === "90+") stops.push("Kredit tarixçəsində 90 gündən çox gecikmə");
    if (income && price && dti > POLICY.stopDti) stops.push(`Borc yükü ${pct(dti)}, hədd ${pct(POLICY.stopDti)}`);

    const od = OVERDUE[i.maxOverdue] ?? 0;
    if (od && od < 100) { score -= od; notes.push(`Keçmiş gecikmə ${i.maxOverdue} gün: −${od}`); }

    if (income && dti <= POLICY.stopDti) {
      const d = dti <= 0.3 ? 0 : dti <= 0.4 ? 10 : dti <= 0.5 ? 25 : 40;
      if (d) notes.push(`Borc yükü ${pct(dti)}: −${d}`);
      score -= d;
    }
    const ten = n("tenureMonths");
    if (ten < POLICY.minTenureMonths) { score -= 20; notes.push(`İş/fəaliyyət stajı ${ten} ay: −20`); }
    else if (ten < 12) { score -= 10; notes.push(`İş/fəaliyyət stajı ${ten} ay: −10`); }
    if (n("activeLoans") >= 4) { score -= 10; notes.push(`${n("activeLoans")} aktiv kredit: −10`); }
    if (price && downPct < POLICY.minDownPct) { score -= 15; notes.push(`İlkin ödəniş ${downPct}%: −15`); }
    else if (downPct >= 30) { score += 5; notes.push(`İlkin ödəniş ${downPct}%: +5`); }
    // A stop factor overrides the points: the application cannot score into an approval band.
    if (stops.length) score = Math.min(score, 40);
    score = Math.max(0, Math.min(100, Math.round(score)));
    const incomplete = !income || !price;

    const grade = stops.length ? "D" : score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : "D";
    const verdict =
      i.overdueNow || i.maxOverdue === "90+" ? "reject" :
      incomplete ? "incomplete" :
      stops.length || grade === "D" ? "reject" :
      !i.docsOk ? "docs" :
      grade === "C" ? "manual" : "approve";

    // Gəlirə görə maksimum: aylıq ödəniş (maxDti × gəlir − mövcud borc) həddini keçmir.
    const room = Math.max(0, POLICY.maxDti * income - debt);
    const r = rate / 100 / 12;
    const maxF = r ? room * (1 - Math.pow(1 + r, -months)) / r : room * months;
    const maxPrice = downPct < 100 ? maxF / (1 - downPct / 100) : 0;

    return { pay, financed: F, dti: isFinite(dti) ? dti : null, score, grade, verdict, stops, notes,
             maxPayment: room, maxPrice: Math.floor(maxPrice / 100) * 100 };
  }
  const pct = x => Math.round(x * 100) + "%";

  const VERDICTS = {
    approve: "Təsdiq tövsiyə olunur",
    incomplete: "Məlumatlar tam deyil",
    manual: "Əlavə baxış lazımdır",
    docs: "Əvvəlcə sənədləri yoxla",
    reject: "İmtina tövsiyə olunur"
  };
  const api = { assess, pmt, POLICY, VERDICTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Scoring = api;
})(this);
