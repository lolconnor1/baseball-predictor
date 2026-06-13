/**
 * node poly-debug.js
 */
async function main() {
  // Try the MLB-specific tag IDs from the sports metadata
  for (const tagId of ['100381', '100639']) {
    console.log(`\n=== tag_id=${tagId} (markets) ===`);
    const url = `https://gamma-api.polymarket.com/markets?tag_id=${tagId}&active=true&closed=false&limit=5`;
    const data = await fetch(url).then(r => r.json());
    const markets = Array.isArray(data) ? data : (data.markets || []);
    console.log(`Count: ${markets.length}`);
    markets.forEach(m => console.log(`  Q: ${m.question}  |  Prices: ${m.outcomePrices}  |  End: ${m.endDate}`));

    console.log(`\n=== tag_id=${tagId} (events) ===`);
    const eurl = `https://gamma-api.polymarket.com/events?tag_id=${tagId}&active=true&closed=false&limit=5`;
    const edata = await fetch(eurl).then(r => r.json());
    const events = Array.isArray(edata) ? edata : (edata.events || []);
    console.log(`Count: ${events.length}`);
    events.forEach(e => {
      console.log(`  Title: ${e.title}  |  Slug: ${e.slug}`);
      const m = e.markets?.[0];
      if (m) console.log(`    First market: ${m.question}  Prices: ${m.outcomePrices}`);
    });
  }
}
main().catch(console.error);