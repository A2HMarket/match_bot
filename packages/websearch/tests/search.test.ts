import { describe, expect, it, vi } from 'vitest';
import { createWebSearch } from '../src/search.js';
import { extractContacts, looksLikeListicle, nameFromTitle } from '../src/extract.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function stubFetch(
  results: { url: string; title: string; content?: string }[],
  pages: Record<string, string>,
) {
  const calls: string[] = [];
  const f = vi.fn((url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('api.tavily.com')) {
      return Promise.resolve(
        new Response(JSON.stringify({ results: results.map((r) => ({ content: '', ...r })) })),
      );
    }
    const html = pages[u];
    return Promise.resolve(html ? new Response(html) : new Response('', { status: 404 }));
  });
  return { f, calls };
}

const SHOP = `<html><head><meta property="og:site_name" content="Polly's Bakehouse"></head>
<body>Custom cakes in Woodford, London E18. <a href="https://wa.me/447700900123">WhatsApp us</a></body></html>`;
const PLUMBER = `<body>Plumber SE1 London <a href="tel:020 7946 0000">Call</a></body>`;
const NO_CONTACT = `<body>Lovely bakery in London. Order in store.</body>`;
const OUTSIDE = `<body>Cakes in Manchester <a href="tel:0161 496 0000">call</a></body>`;

describe('information availability', () => {
  it('distinguishes a successful empty result from rate limiting', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }));
    const service = createWebSearch({ apiKey: 'k', logger, fetchImpl: f as never });
    if (!service.research) throw new Error('missing research');
    expect(await service.research({ query: 'London events' })).toEqual({
      status: 'ok',
      sources: [],
    });
    expect(await service.research({ query: 'London events' })).toEqual({
      status: 'unavailable',
      sources: [],
      reason: 'rate_limited',
    });
  });
});

describe('createWebSearch', () => {
  it('has a separate evidence path that preserves NHS pages without business contacts', async () => {
    const { f } = stubFetch(
      [
        {
          url: 'https://www.nhs.uk/nhs-services/gps/how-to-register-with-a-gp-surgery/',
          title: 'Register with a GP',
          content: 'You do not need an NHS number to register. Registration is free.',
        },
      ],
      {},
    );
    const ws = createWebSearch({ apiKey: 'k', logger, fetchImpl: f as never });
    expect(typeof ws.research).toBe('function');
    if (!ws.research) throw new Error('missing information research');
    const out = await ws.research({
      query: 'register GP no NHS number England',
      domains: ['nhs.uk'],
    });
    expect(out.status).toBe('ok');
    expect(out.sources[0]?.text).toContain('Registration is free');
  });
  it('keeps own sites with a contact and a London mention, drops the rest', async () => {
    const { f, calls } = stubFetch(
      [
        { url: 'https://pollys.example/', title: "Polly's Bakehouse | Custom cakes" },
        { url: 'https://www.checkatrade.com/x', title: 'Checkatrade plumbers' },
        { url: 'https://nocontact.example/', title: 'Nice bakery' },
        { url: 'https://manc.example/', title: 'Manchester cakes' },
        { url: 'https://blog.example/best', title: 'The 10 best bakeries in London' },
        { url: 'https://plumb.example/', title: 'SE1 Plumbing – 24h' },
      ],
      {
        'https://pollys.example/': SHOP,
        'https://nocontact.example/': NO_CONTACT,
        'https://manc.example/': OUTSIDE,
        'https://plumb.example/': PLUMBER,
      },
    );
    const ws = createWebSearch({ apiKey: 'k', logger, fetchImpl: f as never });
    const out = await ws.find({ need: 'birthday cake' });
    expect(out).toEqual([
      {
        ref: 'w1',
        name: "Polly's Bakehouse",
        url: 'https://pollys.example/',
        contact: { whatsapp: '07700900123' },
        evidence: 'contact_on_own_site',
      },
      {
        ref: 'w2',
        name: 'SE1 Plumbing',
        url: 'https://plumb.example/',
        contact: { phone: '02079460000' },
        evidence: 'contact_on_own_site',
      },
    ]);
    // 目录站与榜单页根本不去抓
    expect(calls).not.toContain('https://www.checkatrade.com/x');
    expect(calls).not.toContain('https://blog.example/best');
  });

  it('accepts an Instagram profile that says London, rejects posts and non-London profiles', async () => {
    const { f } = stubFetch(
      [
        {
          url: 'https://www.instagram.com/chinatown.bakery/',
          title: '唐人餅家•Chinatown Bakery (@chinatown.bakery) • Instagram photos and videos',
          content: 'Chinese bakery in London Chinatown',
        },
        { url: 'https://www.instagram.com/p/Cabc123/', title: 'a post', content: 'London cake' },
        {
          url: 'https://www.instagram.com/mancakes/',
          title: 'Manc Cakes (@mancakes)',
          content: 'Manchester',
        },
      ],
      {},
    );
    const out = await createWebSearch({ apiKey: 'k', logger, fetchImpl: f as never }).find({
      need: 'Chinese bakery',
    });
    expect(out).toEqual([
      {
        ref: 'w1',
        name: '唐人餅家•Chinatown Bakery',
        url: 'https://www.instagram.com/chinatown.bakery/',
        contact: { instagram: 'chinatown.bakery' },
        evidence: 'instagram_profile',
      },
    ]);
  });

  it('skips magazine articles and blog posts even when the page has a phone number', async () => {
    const { f, calls } = stubFetch(
      [
        {
          url: 'https://www.gq-magazine.co.uk/grooming/article/best-barbers-london',
          title: 'Barbers',
        },
        { url: 'https://salon.example/blog/our-favourite-cuts', title: 'Our favourite cuts' },
        { url: 'https://salon.example/', title: 'Salon Example' },
      ],
      { 'https://salon.example/': PLUMBER.replace('Plumber', 'Hair salon') },
    );
    const out = await createWebSearch({ apiKey: 'k', logger, fetchImpl: f as never }).find({
      need: 'hairdresser',
    });
    expect(out.map((c) => c.url)).toEqual(['https://salon.example/']);
    expect(calls.some((u) => u.includes('gq-magazine') || u.includes('/blog/'))).toBe(false);
  });

  it('accepts a JS-rendered shop site whose London evidence is only in the domain or snippet', async () => {
    const thin =
      '<html><body><div id="root"></div><a href="https://www.instagram.com/tiantianmarket/">ig</a></body></html>';
    const { f } = stubFetch(
      [
        { url: 'https://www.tiantian.london/', title: 'Asian supermarket | Tian Tian Market' },
        {
          url: 'https://oseyo.example/',
          title: 'Oseyo',
          content: 'Korean supermarket in Battersea, London',
        },
        { url: 'https://thin.example/', title: 'Some shop', content: 'Great shop in Leeds' },
      ],
      {
        'https://www.tiantian.london/': thin,
        'https://oseyo.example/': thin,
        'https://thin.example/': thin,
      },
    );
    const out = await createWebSearch({ apiKey: 'k', logger, fetchImpl: f as never }).find({
      need: 'Chinese supermarket',
    });
    expect(out.map((c) => c.url)).toEqual([
      'https://www.tiantian.london/',
      'https://oseyo.example/',
    ]);
    expect(out[0]?.contact).toEqual({ instagram: 'tiantianmarket' });
  });

  it('skips a shopping-centre retailer page, whose contacts belong to the centre', async () => {
    const { f, calls } = stubFetch(
      [{ url: 'https://mall.example/retailers/oseyo', title: 'Oseyo | Mall', content: 'London' }],
      {},
    );
    const out = await createWebSearch({ apiKey: 'k', logger, fetchImpl: f as never }).find({
      need: 'Korean supermarket',
    });
    expect(out).toEqual([]);
    expect(calls.some((u) => u.includes('/retailers/'))).toBe(false);
  });

  it('retries once when the search comes back empty', async () => {
    let n = 0;
    const f = vi.fn((url: string | URL) => {
      if (String(url).includes('tavily')) {
        n++;
        const results =
          n === 1 ? [] : [{ url: 'https://plumb.example/', title: 'Plumb', content: '' }];
        return Promise.resolve(new Response(JSON.stringify({ results })));
      }
      return Promise.resolve(new Response(PLUMBER));
    });
    const out = await createWebSearch({ apiKey: 'k', logger, fetchImpl: f as never }).find({
      need: 'plumber',
    });
    expect(n).toBe(2);
    expect(out).toHaveLength(1);
  });

  it('refuses an unsafe query before any network call', async () => {
    const f = vi.fn();
    await expect(
      createWebSearch({ apiKey: 'k', logger, fetchImpl: f as never }).find({
        need: 'call 07700 900123',
      }),
    ).rejects.toThrow('search query rejected');
    expect(f).not.toHaveBeenCalled();
  });

  it('dedupes several landing pages of the same site', async () => {
    const { f } = stubFetch(
      [
        { url: 'https://plumb.example/se1', title: 'Plumb SE1' },
        { url: 'https://plumb.example/se16', title: 'Plumb SE16' },
      ],
      { 'https://plumb.example/se1': PLUMBER, 'https://plumb.example/se16': PLUMBER },
    );
    const out = await createWebSearch({ apiKey: 'k', logger, fetchImpl: f as never }).find({
      need: 'plumber',
    });
    expect(out).toHaveLength(1);
  });
});

describe('extract helpers', () => {
  it('keeps apostrophes and decodes entities in the site name', () => {
    expect(
      extractContacts(`<meta property="og:site_name" content="Polly's Bakehouse">`).siteName,
    ).toBe("Polly's Bakehouse");
    expect(
      extractContacts(`<meta property='og:site_name' content='Jo&#39;s &amp; Co'>`).siteName,
    ).toBe("Jo's & Co");
  });
  it('ignores Instagram post/reel links when looking for a profile', () => {
    expect(
      extractContacts('<a href="https://instagram.com/p/abc/">x</a> London').instagram,
    ).toBeNull();
  });
  it('normalises +44 numbers', () => {
    expect(extractContacts('<a href="tel:+44 (0)20 7946 0000">x</a>').phones).toEqual([
      '02079460000',
    ]);
  });
  it('recognises listicles', () => {
    expect(looksLikeListicle('THE BEST 10 Mobile Phone Repair near Regent St')).toBe(true);
    expect(looksLikeListicle('Find the most trusted local Locksmiths in Stratford')).toBe(true);
    expect(looksLikeListicle('Stratford Locksmith | 24/7')).toBe(false);
  });
  it('takes the brand from a title', () => {
    expect(nameFromTitle('Fixfactor | Phone, Laptop & Tablet Repair London')).toBe('Fixfactor');
  });
});
