from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def read(p): return (ROOT/p).read_text()
def write(p,t): (ROOT/p).write_text(t)
def rep(p,o,n):
    t=read(p); c=t.count(o)
    if c!=1: raise RuntimeError(f'{p}: expected one match, got {c}: {o[:120]!r}')
    write(p,t.replace(o,n,1))

# CO-070: configuration/database state, never a source-code person fallback.
rep('src/lib/transactional-email.ts','    process.env.APP_EMAIL || "crfrary@gmail.com",','    process.env.APP_EMAIL || "",')
rep('src/lib/users.ts','  const email = normalizedEmail(emailValue || process.env.APP_EMAIL || "crfrary@gmail.com");','  const email = normalizedEmail(emailValue || process.env.APP_EMAIL || "");')
rep('src/lib/users.ts','  } else if (row.legacy_owner && email === normalizedEmail(process.env.APP_EMAIL || "crfrary@gmail.com")) {','  } else if (row.legacy_owner && Boolean(process.env.APP_EMAIL?.trim()) && email === normalizedEmail(process.env.APP_EMAIL)) {')

# Finish collapsing the duplicate operational Web Push implementation into the hardened shared module.
anchor='export async function sendTestPush(actor: PushActor) {'
insert='''export async function notifyOwnersOfOperationalPush(input: {
  business: Business;
  title: string;
  body: string;
  url: string;
  tag: string;
}) {
  const subscriptions = await ownerSubscriptions(input.business);
  return deliver(subscriptions, {
    title: clean(input.title, 180),
    body: clean(input.body, 500),
    url: clean(input.url, 1000),
    tag: clean(input.tag, 180),
    category: "overtime",
    business: input.business,
  });
}

export async function sendTestPush(actor: PushActor) {'''
rep('src/lib/push-notifications.ts',anchor,insert)

# No real-person identity literals may remain in application source.
forbidden=['crfrary@gmail.com','mike@fraryfuneralhome.com','Michael Frary']
remaining=[]
for path in ROOT.joinpath('src').rglob('*'):
    if path.suffix not in {'.ts','.tsx'}: continue
    text=path.read_text()
    for value in forbidden:
        if value in text: remaining.append(f'{path.relative_to(ROOT)}:{value}')
if remaining: raise RuntimeError(f'hard-coded identities remain in source: {remaining}')

print('Stage 6 identity and shared push transformations applied')
