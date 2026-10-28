// Azərbaycan Kredit Bürosu (AKB) hesabatı: XML-i oxuyur və skorinq üçün göstəriciləri çıxarır.
// Kodların mənası AKB-nin rəsmi sorğu kitabçası ilə yoxlanmalıdır; naməlum kod olduğu kimi göstərilir.
const { XMLParser } = require("fast-xml-parser");

const CREDIT_TYPE = { "001": "Kredit", "002": "Lizinq", "003": "Kredit kartı / xətt" };
const CREDIT_STATUS = { "001": "Bağlanıb", "007": "Aktiv" };
const PURPOSE = { "001": "İstehlak", "002": "Biznes", "003": "İpoteka" };
const COLLATERAL = { "001": "Daşınmaz əmlak", "002": "Avtomobil", "007": "Girovsuz" };
const INQUIRY = { "001": "Kredit müraciəti", "002": "Zəmanət", "005": "Monitorinq", "006": "Şəxsi sorğu" };
// Monitoring and self-checks are not new credit demand, so they don't count as hard inquiries.
const SOFT_INQUIRY = new Set(["005", "006"]);
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
    const active = s(l.creditStatus) !== "001" && !s(l.creditStatusCloseDate);
    const card = s(l.creditType) === "003" || (n(l.initialAmount) === 0 && n(l.lineAmount) > 0);
    const history = arr(l.history?.historyItem).map(h => ({ period: s(h.reportingPeriod), m: periodIndex(h.reportingPeriod), days: n(h.overdueDays) }))
      .filter(h => h.m != null).sort((a, b) => b.m - a.m);
    return {
      bank: s(l.bankName), type: label(CREDIT_TYPE, s(l.creditType)), card, active,
      status: label(CREDIT_STATUS, s(l.creditStatus)), purpose: label(PURPOSE, s(l.creditPurpose)),
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
    hard: !SOFT_INQUIRY.has(s(q.inqPurposeId))
  }));
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

  return {
    reportId: s(r.reportId), reportingDate: s(r.reportingDate), ageDays,
    borrower: { name: s(b.name), fin: reportFin, dateOfBirth: s(b.dateOfBirth), status: s(b.status), fileDate: s(b.fileDate) },
    summary: {
      activeCount: act.length, activeLoans: act.filter(l => !l.card).length, activeCards: act.filter(l => l.card).length,
      closedCount: loans.length - act.length, totalLimit: act.filter(l => l.card).reduce((a, l) => a + l.limit, 0),
      totalOutstanding: Math.round(act.reduce((a, l) => a + l.outstanding, 0)),
      monthlyInstallments: Math.round(monthlyInstallments), cardLoad: Math.round(cardLoad),
      debtMonthly: Math.round(monthlyInstallments + cardLoad),
      currentOverdue, maxOverdue24, maxOverdueAll: loans.reduce((m, l) => Math.max(m, l.maxOverdue), 0), overdueMonths12,
      hardInquiries30, hardInquiries90, historyMonths, prolongations
    },
    // What goes into Scoring.assess
    inputs: {
      overdueNow: currentOverdue > 0, maxOverdue: bucket(maxOverdue24),
      // Unused cards are in debtMonthly via the limit, but they are not counted as open loans.
      activeLoans: act.filter(l => !l.card || l.outstanding > 0).length,
      debtMonthly: Math.round(monthlyInstallments + cardLoad),
      overdueMonths12, hardInquiries90, prolongations, historyMonths, bureau: true
    },
    flags, loans, inquiries: inquiries.slice(0, 30)
  };
}

module.exports = { parse, analyze, CARD_LIMIT_PCT };
