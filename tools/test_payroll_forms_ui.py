"""Browser regression checks using only synthetic data and intercepted local API calls.
Run after npm run build with preview configuration. Requires Playwright for Python
and its Chromium browser; no production database or credentials are used.
"""
import os, time, json, hmac, hashlib, base64, subprocess, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parents[1]
artifacts=Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'corner-payroll-ui-test'
artifacts.mkdir(parents=True, exist_ok=True)
secret='local-fixture-session-'+hashlib.sha256(b'payroll-ui-test').hexdigest()
env=dict(os.environ, VERCEL_ENV='preview', SESSION_SECRET=secret, DATABASE_URL='postgresql://fixture:fixture@localhost:5432/fixture', APP_EMAIL='owner@example.test', BLOB_READ_WRITE_TOKEN='vercel_blob_rw_fixture')
log=open(artifacts / 'server.log','w')
server=subprocess.Popen(['node','node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3137'],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)

base='http://127.0.0.1:3137'
def b64(value):return base64.urlsafe_b64encode(value).decode().rstrip('=')
def token(role='Owner'):
    body=b64(json.dumps({'email':'owner@example.test','role':role,'permissions':['*'] if role=='Owner' else ['workforce.read'],'expiresAt':int((time.time()+3600)*1000)}).encode())
    key=hmac.new(secret.encode(),b'corner-ops-keyring-v1:owner-session',hashlib.sha256).digest()
    return body+'.'+b64(hmac.new(key,body.encode(),hashlib.sha256).digest())
for i in range(50):
    try: urllib.request.urlopen(base+'/signin', timeout=1); break
    except Exception: time.sleep(.1)
record_id='11111111-1111-4111-8111-111111111111'
ssn='000-12-3456'
results=[]
try:
  with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    ctx=browser.new_context(viewport={'width':1360,'height':1000},service_workers='block')
    ctx.add_cookies([{'name':'corner_ops_session','value':token(),'url':base,'httpOnly':True,'sameSite':'Lax'}])
    page=ctx.new_page()
    current_role=['Owner']; calls=[]; fail_next_save=[False]
    profile={'legalName':'Synthetic Employer','dba':'Tiki','ein':'00-0000000','address':'Synthetic Address','phone':'0000000000','payFrequency':'Weekly','payday':'Friday','dependentHealthAvailable':False,'dependentHealthEligibility':''}
    def form(biz): return {'id':record_id,'employeeId':'22222222-2222-4222-8222-222222222222','business':biz,'employeeName':'Synthetic Employee','formType':'W4','title':'Federal Form W-4','templateVersion':'2026','status':'Completed','effectiveDate':'2026-09-01','assignedAt':'2026-09-01T14:00:00Z','assignedBy':'owner@example.test','employeeSignedAt':'2026-09-02T14:00:00Z','employerSignedAt':None,'sourceUrl':'https://example.invalid/blank.pdf'}
    punches=[{'id':str(i),'employeeId':str(i),'employeeName':'Synthetic Employee '+str(i),'position':'Bartender','roleGroup':'In-House','clockIn':'2026-09-01T14:00:00Z','clockOut':'2026-09-01T20:00:00Z','status':'Complete','notes':'','source':'Tiki'} for i in [1,2]]
    def route(r):
      u=r.request.url; path=urllib.parse.urlparse(u).path
      def respond(v,status=200):r.fulfill(status=status,content_type='application/json',body=json.dumps(v))
      if path=='/api/auth/session':respond({'authenticated':True,'configured':True,'missing':[],'role':current_role[0],'permissions':['*'] if current_role[0]=='Owner' else ['workforce.read'],'businesses':['Corner Deli','Tiki'],'email':'owner@example.test','displayName':'Owner'});return
      if path=='/api/employment-forms/completed':
        data=r.request.post_data_json; calls.append(data)
        record=form(data['business']);record['payload']={'employeeSubmission':{'firstName':'Synthetic','ssn':ssn,'filingStatus':'Single','extraWithholding':'0.00','address':{'zip':'00001'}},'employeeAttestation':{'signatureName':'Synthetic Employee','signedAt':'2026-09-02T14:00:00Z'},'employer':profile}
        respond({'form':record,'sensitive':True});return
      if path=='/api/employment-forms':
        q=urllib.parse.parse_qs(urllib.parse.urlparse(u).query);biz=q.get('business',['Corner Deli'])[0]
        if 'id' in q:
          record=form(biz);record['payload']={'employeeSubmission':{'firstName':'Synthetic'}};record['events']=[];respond({'form':record})
        else:respond({'business':biz,'profile':profile,'employees':[],'forms':[form(biz)]})
        return
      if path=='/api/tiki-time-corrections':
        if r.request.method=='POST':
          calls.append(r.request.post_data_json)
          if fail_next_save[0]:fail_next_save[0]=False;respond({'error':'Synthetic save failure'},500)
          else:respond({'corrected':True,'punch':{'clockInEastern':'10:00 AM','clockOutEastern':'4:00 PM'}})
        else:respond({'weekStart':'2026-08-31','punches':punches})
        return
      if path=='/api/payroll-control':
        respond({'summary':{'source':'Tiki','weekStart':'2026-08-31','weekEnd':'2026-09-06','rows':[],'overrides':[],'unmatchedTips':[],'dailyTipReconciliation':[]},'punches':punches,'versions':[],'adjustments':[],'auditEvents':[]});return
      respond({'messages':0,'employees':[],'punches':[]})
    import urllib.parse
    ctx.route('**/api/**',route)
    page.goto(base+'/ops/employment-forms')
    expect(page.get_by_role('button',name='View completed form',exact=True)).to_be_visible()
    assert ssn not in page.locator('body').inner_text()
    page.get_by_role('button',name='View completed form',exact=True).click()
    dialog=page.get_by_role('dialog')
    expect(dialog.get_by_text(ssn,exact=True)).to_be_visible()
    expect(dialog.get_by_text('Social Security number (SSN)',exact=True)).to_be_visible()
    expect(dialog.get_by_text('Employee signature and attestation')).to_be_visible()
    assert ssn not in page.evaluate('JSON.stringify(localStorage) + JSON.stringify(sessionStorage)')
    page.screenshot(path=str(artifacts / 'completed-form.png'),full_page=True)
    page.get_by_role('button',name='Hide and close').click()
    expect(dialog).not_to_be_visible();assert ssn not in page.locator('body').inner_text()
    results.append('Owner explicit form view reveals original synthetic SSN and signatures; close clears view; no browser storage')
    page.get_by_role('button',name='View completed form',exact=True).click();expect(dialog.get_by_text(ssn,exact=True)).to_be_visible()
    page.evaluate("Object.defineProperty(document, 'visibilityState', {configurable:true,value:'hidden'}); document.dispatchEvent(new Event('visibilitychange'))")
    expect(dialog).not_to_be_visible();page.evaluate("Object.defineProperty(document, 'visibilityState', {configurable:true,value:'visible'})")
    results.append('Hiding tab closes sensitive view')
    current_role[0]='Viewer';page.reload()
    expect(page.get_by_role('button',name='Review',exact=True)).to_be_visible()
    expect(page.get_by_role('button',name='View completed form',exact=True)).to_have_count(0)
    assert ssn not in page.locator('body').inner_text()
    results.append('Viewer is not offered sensitive form action')
    current_role[0]='Owner';page.goto(base+'/ops/tiki-time-corrections')
    page.get_by_role('button',name='Edit times',exact=True).first.click()
    note=page.locator('textarea[name=reason]');expect(note).to_have_value('Owner time correction')
    note.fill('');page.get_by_role('button',name='Save correction',exact=True).click();expect(note).to_have_count(0)
    assert calls[-1]['reason']=='Owner time correction'
    page.get_by_role('button',name='Edit times',exact=True).first.click();note.fill('Employee forgot to clock out')
    fail_next_save[0]=True;page.get_by_role('button',name='Save correction',exact=True).click();expect(page.get_by_text('Save failed:',exact=True)).to_be_visible();expect(note).to_have_value('Employee forgot to clock out')
    page.get_by_role('button',name='Save correction',exact=True).click();expect(note).to_have_count(0)
    page.get_by_role('button',name='Edit times',exact=True).nth(1).click();expect(note).to_have_value('Employee forgot to clock out')
    results.append('Tiki blank reason saves with default; failure retains custom note; next employee retains note')
    page.goto(base+'/ops/payroll-control')
    page.locator('.businessPills').get_by_role('button',name='Tiki',exact=True).click()
    page.get_by_role('button',name='Correct shift',exact=True).first.click()
    note=page.locator('textarea[name=reason]');expect(note).to_have_value('Owner time correction');note.fill('')
    page.get_by_role('button',name='Save & recalculate',exact=True).click();expect(note).to_have_count(0)
    assert calls[-1]['reason']=='Owner time correction'
    results.append('Unified payroll Tiki correction saves with a blank reason')
    ctx.close();browser.close()
finally:
  server.terminate();server.wait(timeout=10)
  (artifacts / 'results.json').write_text(json.dumps(results,indent=2))
  print('\n'.join(results))
