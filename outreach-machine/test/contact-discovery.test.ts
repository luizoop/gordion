import {describe,it,expect} from 'vitest';
import {discoverContacts} from '../src/research/contact-discovery.js';
describe('Published contact discovery',()=> {
  it('keeps personal publication separate from role verification and never guesses names',()=> {
    const r=discoverContacts('<p>CEO Alex Example <a href="mailto:alex@example.org">Email</a></p><p>bob@example.org</p>','https://example.org/team');
    expect(r.contacts).toMatchObject([{email:'alex@example.org',kind:'personal',role:'CEO'},{email:'bob@example.org',kind:'unverified',role:null}]);
  });
  it('rejects generic/privacy/vendor addresses and script content',()=> {
    const r=discoverContacts('<script>ceo@example.org</script><p>info@example.org office@example.org dpo@example.org supplier@elsewhere.org</p><a href="mailto:team_compliance@example.org">Compliance</a>','https://www.example.org/');
    expect(r.contacts).toHaveLength(1);expect(r.contacts[0]).toMatchObject({email:'team_compliance@example.org',kind:'functional'});
    expect(r.excluded).toHaveLength(4);
  });
  it('does not assign a CEO role from a page-wide or multi-address block',()=> {
    const r=discoverContacts('<div>CEO Alex <span>a@example.org b@example.org</span></div>','https://example.org/');
    expect(r.contacts.every(c=>c.kind==='unverified')).toBe(true);
  });
  it('finds multilingual contact links, ignores external links and survives malformed mailto',()=> {
    const r=discoverContacts('<a href="mailto:%GG">Bad</a><a href="/контакти">Контакти</a><a href="/kapcsolat">Kapcsolat</a><a href="https://elsewhere.org/contact">External</a>','https://example.org/');
    expect(r.links).toHaveLength(2);expect(r.contacts).toHaveLength(0);
  });
  it('never reads a job title out of an email address or trusts mismatched mailto text',()=> {
    const r=discoverContacts('<p><a href="mailto:orders@example.org">compliance@example.org</a></p>','https://example.org/contact');
    expect(r.contacts).toHaveLength(2);expect(r.contacts.every(c=>c.kind==='unverified'&&c.role===null&&c.notes.includes('mailto_display_mismatch'))).toBe(true);
  });
  it('does not import a privacy-purpose address as a trading/compliance decision maker',()=> {
    const r=discoverContacts('<div><h3>Službenik za zaštitu osobnh podataka</h3><p>E-mail: compliance@example.org</p></div>','https://example.org/contact');
    expect(r.contacts[0]).toMatchObject({kind:'unverified',notes:['privacy_contact_context']});
  });
  it('does not turn general mentions of operations or trading into a personal job title',()=> {
    const r=discoverContacts('<p>Complaints relating to operations, contracts or trading: helpdesk@example.org</p><p>Customer service: customerservice@example.org</p>','https://example.org/contact');
    expect(r.contacts).toHaveLength(1);expect(r.contacts[0]).toMatchObject({kind:'unverified',role:null});
    expect(r.excluded).toContain('customerservice@example.org');
  });
});
