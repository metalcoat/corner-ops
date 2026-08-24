from pathlib import Path
p=Path(__file__).resolve().parents[1]/'src/app/api/integrations/route.ts'
t=p.read_text()
old='''    if (action === "plaid-update-complete") {
      const business = businessFrom(body.business);
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      return Response.json(await syncBankConnection(String(body.connectionId || "")));
    }
'''
new='''    if (action === "plaid-update-complete") {
      const business = businessFrom(body.business);
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      return Response.json(await syncBankConnection(String(body.connectionId || ""), business));
    }
'''
if t.count(old)!=1: raise RuntimeError(f'plaid-update-complete block count {t.count(old)}')
p.write_text(t.replace(old,new,1))
print('Stage 2 Plaid update scope fixup applied')
