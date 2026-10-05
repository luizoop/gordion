import {describe,it,expect} from 'vitest';
import {EU_COUNTRIES} from '../src/domain/autopilot.js';
import {legalResearchFor} from '../src/domain/legal-research.js';
describe('Legal research is not authorization',()=> {
  it('never grants permission, including conditional B2B routes',()=> {
    for(const country of EU_COUNTRIES) {
      const r=legalResearchFor(country);expect(r.grantsPermission).toBe(false);
      expect(r.requirements.some(x=>x.includes('Deutschland'))).toBe(true);
      if(r.checkedOn) expect(r.sources.length).toBeGreaterThan(0);
    }
    expect(legalResearchFor('BG').status).toBe('conditional_b2b_review');
    expect(legalResearchFor('FR').status).toBe('conditional_b2b_review');
  });
  it('marks missing research explicitly instead of inheriting another country rule',()=> {
    expect(legalResearchFor('CY')).toMatchObject({status:'not_researched',checkedOn:null,sources:[],grantsPermission:false});
    expect(legalResearchFor('')).toMatchObject({status:'not_researched',grantsPermission:false});
  });
});
