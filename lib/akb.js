// Azərbaycan Kredit Bürosu (AKB) hesabatı: XML-i oxuyur və skorinq üçün göstəriciləri çıxarır.
// Kod cədvəlləri AKB-nin texniki sənədindən (bölmə 5) götürülüb; naməlum kod olduğu kimi göstərilir.
const { XMLParser } = require("fast-xml-parser");

// Code tables from AKB's technical document, section 5.
const CREDIT_TYPE = { "001": "Kredit", "002": "Kredit xətti", "003": "Kredit kartı", "004": "Qarantiya və zaminlik", "005": "Overdraft",
  "007": "Lizinq", "008": "Faktorinq", "009": "Kirayə mənzil", "010": "Tranş kredit", "011": "Çərçivə sazişi" };
// Limits that can be drawn at will: treated like a card (5% of the limit a month).
const LINE_TYPES = new Set(["002", "003", "005"]);
const CREDIT_STATUS = { "001": "Tam ödənilmiş", "002": "Faizləri hesablanmayan", "003": "Balansdan silinmiş", "004": "Restrukturizasiya edilmiş",
  "005": "Restruktur. edilmiş, faiz hesablanmayan", "006": "Digər statuslu", "007": "İşlək", "008": "Qeyri-işlək",
  "009": "Pandemiya səbəbindən gecikdirilmiş", "010": "Pandemiya səbəbindən gecikdirilmiş, bağlı", "011": "Tələb hüququ üçüncü şəxsə ötürülüb",
  "012": "Ləğv edilmiş", "013": "Məhkəmə prosesindədir", "014": "Təminat hesabına ödənilib", "015": "Məcburi icra nəticəsində ödənilib",
  "016": "Öhdəlik başqa şəxsə ötürülüb", "017": "Restrukturizasiya / tam ödənilmiş", "018": "Restrukturizasiya / balansdan silinmiş",
  "019": "Restrukturizasiya / işlək", "020": "Restrukturizasiya / qeyri-işlək" };
const CLOSED_STATUS = new Set(["001", "010", "011", "012", "014", "015", "016", "017"]);
// Statuses a lender has to look at: written off, non-performing, in court, collected by force, restructured.
const BAD_STATUS = new Set(["003", "008", "013", "015", "018", "020"]);
const RESTRUCTURED = new Set(["004", "005", "017", "018", "019", "020"]);
const PURPOSE = { "001": "İstehlak", "002": "Neft sektoru", "003": "İpoteka", "004": "Ticarət və xidmət", "005": "Energetika, kimya, təbii ehtiyatlar",
  "006": "Kənd təsərrüfatı və emal", "007": "İnşaat və əmlak", "008": "Sənaye və istehsal", "009": "Nəqliyyat və rabitə", "010": "Digər sektorlar",
  "011": "Satmaq öhdəliyi ilə kirayə" };
const COLLATERAL = { "001": "Daşınmaz əmlak", "002": "Daşınan əmlak", "003": "Hesabda nağd vəsait", "004": "Zaminlik", "005": "Qarantiya",
  "006": "Digər", "007": "Təminatsız", "008": "Çərçivə sazişi" };
const INQUIRY = { "001": "Kredit müraciəti", "002": "Kredit xətti müraciəti", "003": "Zaminin sorğulanması", "004": "Təsisçinin sorğulanması",
  "005": "Cari borcalanın sorğulanması", "006": "Şəxsi sorğu", "011": "Notariat", "012": "Məhkəmə işi", "013": "İcra işi" };
const ORG_TYPE = { "001": "Bank", "002": "BOKT", "003": "Kredit Bürosu", "004": "Sığorta", "005": "Lizinq", "006": "Kredit İttifaqı",
  "007": "Digər hüquqi şəxs", "008": "Hissəli satış", "009": "Faktorinq", "010": "Kollektor", "011": "Lombard", "012": "Mobil operator", "013": "Elektron pul təşkilatı" };
const SCORE_RESPONSE = { AB: "Cari aktiv öhdəlikdə yüksək gecikmə var", CC: "Son 12 ayda aktiv öhdəlik olmayıb", TN: "Qiymətləndirmə üçün çox yenidir",
  NC: "Heç bir kredit öhdəliyi yoxdur", TY: "Yaşı 16-dan kiçikdir", NU: "Yenilənməmiş aktiv kreditləri var", LP: "Hüquqi şəxsə skor verilmir" };
const scoreBand = p => p >= 860 ? "Əla" : p >= 750 ? "Yaxşı" : p >= 600 ? "Orta" : p >= 200 ? "Kafi" : p >= 1 ? "Pis" : "";
// Only an application for a loan or a credit line is new credit demand; monitoring, self-checks, guarantor,
// founder, notary, court and enforcement checks don't count as hard inquiries.
const HARD_INQUIRY = new Set(["001", "002"]);
// Card and credit-line limits count as a monthly obligation even when unused.
const CARD_LIMIT_PCT = 0.05;

const label = (dict, code) => dict[code] || (code ? `Kod ${code}` : "—");
const arr = v => v == null || v === "" ? [] : Array.isArray(v) ? v : [v];
const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const s = v => v == null ? "" : String(v).trim();

function parse(xmlText) {
  const text = String(xmlText || "");
  // Reports copied from a browser start with a "This XML file does not appear..." line; skip to the first tag.
  const start = text.indexOf("<");
  if (start < 0) throw new Error("XML tapılmadı.");
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: false, trimValues: true });
  let doc;
  try { doc = parser.parse(text.slice(start)); } catch { throw new Error("XML oxunmadı, faylın strukturu pozulub."); }
  const r = doc.inquiryResult;
  if (!r || !r.borrower) throw new Error("Bu AKB hesabatı deyil: inquiryResult/borrower tapılmadı.");
  return r;
}

const monthIndex = d => d.getUTCFullYear() * 12 + d.getUTCMonth();
// "08x2025" → month index
const periodIndex = p => { const m = /^(\d{1,2})x(\d{4})$/.exec(s(p)); return m ? +m[2] * 12 + (+m[1] - 1) : null; };
const date = v => { const t = Date.parse(s(v)); return Number.isFinite(t) ? new Date(t) : null; };

function analyze(r, { fin, now = new Date() } = {}) {
  const b = r.borrower || {};
  const reported = date(r.reportingDate) || now;
  const nowM = monthIndex(reported);

  const loans = arr(r.liabilities?.liability).map(l => {
    const st = s(l.creditStatus);
    const active = !CLOSED_STATUS.has(st) && !s(l.creditStatusCloseDate);
    const card = LINE_TYPES.has(s(l.creditType)) || (n(l.initialAmount) === 0 && n(l.lineAmount) > 0);
    const history = arr(l.history?.historyItem).map(h => ({ period: s(h.reportingPeriod), m: periodIndex(h.reportingPeriod), days: n(h.overdueDays) }))
      .filter(h => h.m != null).sort((a, b) => b.m - a.m);
    return {
      bank: s(l.bankName), type: label(CREDIT_TYPE, s(l.creditType)), card, active,
      status: label(CREDIT_STATUS, st), statusCode: st, bad: BAD_STATUS.has(st), restructured: RESTRUCTURED.has(st),
      org: ORG_TYPE[s(l.orgIDType)] || "", coBorrowers: n(l.coBorrowerCount), lastPayment: s(l.lastPaymentDate), purpose: label(PURPOSE, s(l.creditPurpose)),
      collateral: label(COLLATERAL, s(l.collateralCode)) + (s(l.collateralAnyInfo) ? ` · ${s(l.collateralAnyInfo)}` : ""),
      currency: s(l.currency) || "AZN", grantedOn: s(l.grantedOn), dueOn: s(l.contractDueOn), closedOn: s(l.creditStatusCloseDate),
      amount: n(l.initialAmount), limit: n(l.lineAmount), rate: n(l.interestRate),
      outstanding: Math.round((n(l.outstandingDebtMain) + n(l.outstandingDebtInterest)) * 100) / 100,
      monthly: n(l.monthlyPaymentAmount), prolongations: n(l.prolongations),
      overdueNow: Math.max(n(l.daysMainSumOverdue), n(l.daysInterestOverdue)),
      history: history.slice(0, 24).map(h => ({ period: h.period, days: h.days, ago: nowM - h.m })),
      maxOverdue: history.reduce((m, h) => Math.max(m, h.days), 0)
    };
  });

  const act = loans.filter(l => l.active);
  const monthlyInstallments = act.filter(l => !l.card).reduce((a, l) => a + l.monthly, 0);
  const cardLoad = act.filter(l => l.card).reduce((a, l) => a + Math.max(l.limit, l.outstanding) * CARD_LIMIT_PCT, 0);
  const allHistory = loans.flatMap(l => l.history);
  const inWindow = k => allHistory.filter(h => h.ago >= 0 && h.ago < k);
  const maxOverdue24 = inWindow(24).reduce((m, h) => Math.max(m, h.days), 0);
  const overdueMonths12 = new Set(inWindow(12).filter(h => h.days > 0).map(h => h.period)).size;
  const currentOverdue = act.reduce((m, l) => Math.max(m, l.overdueNow), 0);

  const inquiries = arr(r.inquiryHistory?.inquiryHistoryItem).map(q => ({
    org: s(q.inqBankName), date: s(q.inqDate).slice(0, 10), purpose: label(INQUIRY, s(q.inqPurposeId)),
    hard: HARD_INQUIRY.has(s(q.inqPurposeId)), online: s(q.inqType) !== "2"
  }));

  // Loans where this person is a co-borrower, and loans of others they stand guarantor for (AKB 2.2).
  const coLoans = arr(r.coBorrowers?.liability).map(l => ({
    bank: s(l.bankName), type: label(CREDIT_TYPE, s(l.creditType)), status: label(CREDIT_STATUS, s(l.creditStatus)),
    active: !CLOSED_STATUS.has(s(l.creditStatus)) && !s(l.creditStatusCloseDate), currency: s(l.currency) || "AZN",
    grantedOn: s(l.grantedOn), dueOn: s(l.contractDueOn), amount: n(l.initialAmount), monthly: n(l.monthlyPaymentAmount),
    outstanding: Math.round((n(l.outstandingDebtMain) + n(l.outstandingDebtInterest)) * 100) / 100,
    overdueNow: Math.max(n(l.daysMainSumOverdue), n(l.daysInterestOverdue)), coBorrowers: n(l.coBorrowerCount) }));
  const guarantees = arr(r.guarantee?.guarantee).filter(g => g && typeof g === "object").map(g => ({
    bank: s(g.guaBankName), borrower: s(g.guaBorrowerName), type: label(CREDIT_TYPE, s(g.guaCreditType)), status: label(CREDIT_STATUS, s(g.guaCreditStatus)),
    active: !CLOSED_STATUS.has(s(g.guaCreditStatus)) && !s(g.guaCreditStatusCloseDate), currency: s(g.guaCurrency) || "AZN",
    grantedOn: s(g.guaGrantedOn), dueOn: s(g.guaContractDueOn), amount: n(g.guaInitialAmount), monthly: n(g.guaMonthlyPaymentAmount),
    outstanding: Math.round((n(g.guaOutstandingDebt) + n(g.guaInterestAmount)) * 100) / 100,
    overdueNow: Math.max(n(g.guaDaysMainSumOverdue), n(g.guaDaysInterestOverdue)) }));
  const sc = r.score && typeof r.score === "object" ? r.score : null;
  const point = sc ? n(sc.point) : 0;
  const score = sc ? { calculated: s(sc.calculated) === "true", point: point || null, band: scoreBand(point),
    response: s(sc.response), reason: SCORE_RESPONSE[s(sc.response)] || "" } : null;
  const flagObj = o => o && typeof o === "object" ? { status: s(o.status), title: s(o.title), description: s(o.description) } : null;
  const cas = flagObj(r.cas), kaqs = flagObj(r.kaqs);
  const daysAgo = d => (reported - (date(d) || reported)) / 864e5;
  const hardInquiries90 = inquiries.filter(q => q.hard && daysAgo(q.date) <= 90).length;
  const hardInquiries30 = inquiries.filter(q => q.hard && daysAgo(q.date) <= 30).length;

  const firstDates = loans.map(l => date(l.grantedOn)).filter(Boolean).concat(date(b.fileDate) || []);
  const first = firstDates.length ? new Date(Math.min(...firstDates)) : null;
  const historyMonths = first ? Math.max(0, nowM - monthIndex(first)) : 0;
  const prolongations = act.reduce((a, l) => a + l.prolongations, 0);

  const bucket = d => d <= 0 ? "0" : d <= 30 ? "1-30" : d <= 90 ? "31-90" : "90+";
  const flags = [];
  const reportFin = s(b.fin).toUpperCase();
  if (fin && reportFin && reportFin !== String(fin).toUpperCase()) flags.push(`FİN uyğun gəlmir: hesabatda ${reportFin}, müraciətdə ${String(fin).toUpperCase()}`);
  const ageDays = Math.floor((now - reported) / 864e5);
  if (ageDays > 30) flags.push(`Hesabat ${ageDays} gün əvvəl hazırlanıb, yenisini sorğula`);
  if (s(b.status) && s(b.status) !== "ACTIVE") flags.push(`Borcalanın statusu: ${s(b.status)}`);
  if (currentOverdue) flags.push(`Hazırda ${currentOverdue} gün gecikmə var`);
  if (prolongations) flags.push(`${prolongations} dəfə müddət uzadılıb (restrukturizasiya)`);
  if (cas?.status === "ACTIVE") flags.push(`Özünəqadağa aktivdir: ${cas.title || "kredit müqaviləsi bağlana bilməz"}`);
  for (const l of act.filter(l => l.bad)) flags.push(`${l.bank || "Kredit"}: status "${l.status}"`);
  if (act.some(l => l.restructured)) flags.push("Restrukturizasiya edilmiş aktiv öhdəlik var");
  const coAct = coLoans.filter(l => l.active), guaAct = guarantees.filter(g => g.active);
  if (coAct.length) flags.push(`${coAct.length} aktiv kreditdə birgə borcalandır, aylıq ${Math.round(coAct.reduce((a, l) => a + l.monthly, 0))} ₼`);
  if (guaAct.length) flags.push(`${guaAct.length} aktiv kreditdə zamindir, qalıq ${Math.round(guaAct.reduce((a, g) => a + g.outstanding, 0))} ₼`);
  if (guaAct.some(g => g.overdueNow > 0)) flags.push("Zamin olduğu kreditdə hazırda gecikmə var");
  if (score && score.calculated && score.point && score.point < 200) flags.push(`AKB skoru aşağıdır: ${score.point} (${score.band})`);

  return {
    reportId: s(r.reportId), reportingDate: s(r.reportingDate), ageDays,
    borrower: { name: s(b.name), fin: reportFin, documentNo: s(b.documentNo), dateOfBirth: s(b.dateOfBirth), status: s(b.status), fileDate: s(b.fileDate),
                address: s(b.registeredAddress || b.address || b.registrationAddress), birthPlace: s(b.placeOfBirth || b.birthPlace),
                city: s(b.locationCity), personType: s(b.personType), veteran: s(b.participantOfPatrioticWar) === "true" },
    summary: {
      activeCount: act.length, activeLoans: act.filter(l => !l.card).length, activeCards: act.filter(l => l.card).length,
      closedCount: loans.length - act.length, totalLimit: act.filter(l => l.card).reduce((a, l) => a + l.limit, 0),
      totalOutstanding: Math.round(act.reduce((a, l) => a + l.outstanding, 0)),
      monthlyInstallments: Math.round(monthlyInstallments), cardLoad: Math.round(cardLoad),
      debtMonthly: Math.round(monthlyInstallments + cardLoad),
      currentOverdue, maxOverdue24, maxOverdueAll: loans.reduce((m, l) => Math.max(m, l.maxOverdue), 0), overdueMonths12,
      hardInquiries30, hardInquiries90, historyMonths, prolongations,
      coActive: coAct.length, coMonthly: Math.round(coAct.reduce((a, l) => a + l.monthly, 0)),
      guaranteesActive: guaAct.length, guaranteeOutstanding: Math.round(guaAct.reduce((a, g) => a + g.outstanding, 0))
    },
    score, cas, kaqs, balance: r.balance != null && r.balance !== "" ? n(r.balance) : null,
    // What goes into Scoring.assess
    inputs: {
      overdueNow: currentOverdue > 0, maxOverdue: bucket(maxOverdue24),
      // Unused cards are in debtMonthly via the limit, but they are not counted as open loans.
      activeLoans: act.filter(l => !l.card || l.outstanding > 0).length,
      debtMonthly: Math.round(monthlyInstallments + cardLoad),
      overdueMonths12, hardInquiries90, prolongations, historyMonths, bureau: true
    },
    flags, loans, coLoans, guarantees, inquiries: inquiries.slice(0, 200)
  };
}

module.exports = { parse, analyze, CARD_LIMIT_PCT };
