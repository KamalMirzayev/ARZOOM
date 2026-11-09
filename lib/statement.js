// Card and bank statements: every dated line with an amount becomes a transaction, sorted into income and expense categories.
// Direction comes from the sign (+/-), then from words in the line, then from the category's usual direction.
const CATEGORIES = {
  in: [
    ["salary", "Əmək haqqı", /(emek haqq|maas|zarplat|zarabotn|salary|payroll|avans)/],
    ["pension_social", "Pensiya, sosial ödəniş", /(pensiya|pensi|teqaud|muavinet|dsmf|sosial|posobi)/],
    ["loan_in", "Kredit, borc mədaxili", /(kredit(in)? (verilmesi|medaxil|mebleg)|loan disburs|vydacha kredit)/],
    ["cash_in", "Nağd mədaxil", /(nagd medaxil|kassa|cash ?in|vznos|nalichn|terminal(dan)? medaxil|emanet)/],
    ["refund", "Geri qaytarma, keşbek", /(qaytarma|refund|vozvrat|cash ?back|kesbek|keshbek)/],
    ["transfer_in", "Köçürmə (daxil olan)", /(kocurme|perevod|transfer|kartdan karta|card ?to ?card|p2p|m10|emanet)/],
    ["other_in", "Digər mədaxil", null]
  ],
  out: [
    ["gambling", "Mərc, kazino", /(\bbet\b|1xbet|melbet|mostbet|betandyou|topaz|kazino|casino|poker|bukmeker|parimatch|pin-?up|vulkan|stavk)/],
    ["cash_out", "Nağdlaşdırma (ATM)", /(\batm\b|nagdlas|cash withdrawal|snyat|bankomat)/],
    ["loan_payment", "Kredit ödənişi", /(kredit|loan|lizinq|ipoteka|kreditin|borcun odenil)/],
    ["groceries", "Market, ərzaq", /(supermarket|market|araz|bravo|bazarstore|neptun|rahat|\boba\b|grand mart|spar|ərzaq|erzaq|produkt)/],
    ["food_out", "Restoran, kafe, çatdırılma", /(restoran|restaurant|kafe|cafe|coffee|kofe|wolt|bolt food|yemek|mcdonald|kfc|pizza|burger|doner|shaurma)/],
    ["transport", "Nəqliyyat, yanacaq", /(taksi|taxi|\bbolt\b|uber|yango|\bazs\b|socar|lukoil|azpetrol|yanacaq|benzin|bakikart|metro|parking|parkovk)/],
    ["utilities_telecom", "Kommunal, mobil, internet", /(azerisiq|azersu|azeriqaz|kommunal|azercell|bakcell|\bnar\b|narmobile|internet|aztelekom|citynet|ktv|katv|mobil)/],
    ["health", "Səhiyyə, aptek", /(aptek|apteka|pharm|klinika|xestexana|hospital|medical|tibb|stomatolog|labor)/],
    ["shopping", "Geyim, onlayn alış-veriş", /(trendyol|amazon|aliexpress|temu|umico|birmarket|zara|waikiki|\bmall\b|geyim|shop|store|magaz)/],
    ["education", "Təhsil", /(universitet|mekteb|tehsil|kurs|school|university|bagca)/],
    ["fees", "Bank xidmət haqqı", /(komissiya|commission|xidmet haqqi|illik xidmet|\bfee\b)/],
    ["transfer_out", "Köçürmə (çıxan)", /(kocurme|perevod|transfer|kartdan karta|card ?to ?card|p2p|m10)/],
    ["other_out", "Digər xərc", null]
  ]
};
const IN_WORDS = /(medaxil|daxilolma|daxil olan|zachisl|postuplen|incoming|credit\b|kredit\s*\+)/;
const OUT_WORDS = /(\bpos\b|odenis|alis|purchase|spisan|oplat|pokupk|debit\b|mexaric|outgoing)/;

function classify(desc, dir) {
  for (const [key, label, re] of CATEGORIES[dir]) if (!re || re.test(desc)) return { key, label };
}

// lines: [{ raw, plain, dates: [iso], amounts: [{ value, sign }] }]
function parse(lines) {
  const tx = [];
  for (const l of lines) {
    if (!l.dates.length || !l.amounts.length) continue;
    // the signed amount if there is one, else the first; a second unsigned number is usually the balance
    const a = l.amounts.find(x => x.sign) || l.amounts[0];
    const desc = l.descPlain;
    let dir = a.sign === "+" ? "in" : a.sign === "-" ? "out" : IN_WORDS.test(desc) ? "in" : OUT_WORDS.test(desc) ? "out" : null;
    if (!dir) {
      const asIn = classify(desc, "in");
      dir = asIn.key !== "other_in" && asIn.key !== "transfer_in" ? "in" : "out";
    }
    const cat = classify(desc, dir);
    tx.push({ date: l.dates[0], desc: l.desc.slice(0, 80), amount: a.value, dir, cat: cat.key, label: cat.label });
  }
  return tx;
}

const r2 = n => Math.round(n * 100) / 100;
function summarize(tx) {
  const months = [...new Set(tx.map(t => t.date.slice(0, 7)))].sort();
  const nMonths = Math.max(1, months.length);
  const group = dir => {
    const m = new Map();
    for (const t of tx.filter(t => t.dir === dir)) {
      const g = m.get(t.cat) || { key: t.cat, label: t.label, total: 0, count: 0 };
      g.total = r2(g.total + t.amount); g.count++; m.set(t.cat, g);
    }
    const total = r2([...m.values()].reduce((s, g) => s + g.total, 0));
    return { total, monthly: r2(total / nMonths),
             categories: [...m.values()].sort((a, b) => b.total - a.total).map(g => ({ ...g, monthly: r2(g.total / nMonths), share: total ? Math.round(g.total / total * 100) : 0 })) };
  };
  const income = group("in"), expense = group("out");
  // income per month: salary if there is any, else everything except own cash, refunds and loans
  const steady = tx.some(t => t.dir === "in" && t.cat === "salary") ? ["salary"] : ["pension_social", "transfer_in", "other_in", "salary"];
  const perMonth = months.map(m => ({ month: m, amount: r2(tx.filter(t => t.dir === "in" && steady.includes(t.cat) && t.date.startsWith(m)).reduce((s, t) => s + t.amount, 0)), note: steady[0] === "salary" ? "əmək haqqı" : "daimi mədaxil" }))
    .filter(x => x.amount > 0);
  return { months, income, expense, perMonth, net_monthly: r2(income.monthly - expense.monthly) };
}

function flags(s) {
  const f = [], cat = (dir, k) => s[dir === "in" ? "income" : "expense"].categories.find(c => c.key === k);
  const gam = cat("out", "gambling");
  if (gam) f.push(`Mərc və kazino xərcləri: ${gam.total} AZN (${gam.count} əməliyyat)`);
  const cash = cat("in", "cash_in");
  if (cash && cash.share >= 30) f.push(`Mədaxilin ${cash.share}%-i nağd mədaxildir, mənbəyini yoxlayın`);
  const loan = cat("out", "loan_payment");
  if (loan && s.income.monthly && loan.monthly > s.income.monthly * 0.3)
    f.push(`Aylıq kredit ödənişləri (~${loan.monthly} AZN) mədaxilin ${Math.round(loan.monthly / s.income.monthly * 100)}%-idir`);
  else if (loan) f.push(`Başqa kredit ödənişi var: ayda ~${loan.monthly} AZN, AKB hesabatı ilə tutuşdurun`);
  if (s.expense.total > s.income.total * 1.05) f.push("Xərclər mədaxildən çoxdur");
  const loanIn = cat("in", "loan_in");
  if (loanIn) f.push(`Dövr ərzində kredit/borc mədaxili var: ${loanIn.total} AZN`);
  return f;
}

module.exports = { parse, summarize, flags, CATEGORIES };
