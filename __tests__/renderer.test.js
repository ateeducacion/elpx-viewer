const { parseContentXml } = require('../src/validator.js');
const { generateElpViewData } = require('../src/renderer.js');

describe('generateElpViewData', () => {
  test('returns empty array when there are no navigation structures', () => {
    const xml = '<?xml version="1.0"?><ode></ode>';
    const { document } = parseContentXml(xml);
    const pages = generateElpViewData(document);
    expect(Array.isArray(pages)).toBe(true);
    expect(pages).toHaveLength(0);
  });

  test('uses pageName as title and falls back to odePageId when missing', () => {
    const xml = `<?xml version="1.0"?>
      <ode>
        <odeNavStructures>
          <odeNavStructure>
            <odePageId>p1</odePageId>
            <pageName>Start Page</pageName>
            <odeNavStructureOrder>1</odeNavStructureOrder>
            <odePagStructures>
              <odePagStructure>
                <odeComponents>
                  <odeComponent>
                    <htmlView><![CDATA[<p>Hello world</p>]]></htmlView>
                  </odeComponent>
                </odeComponents>
              </odePagStructure>
            </odePagStructures>
          </odeNavStructure>
          <odeNavStructure>
            <odePageId>p2</odePageId>
            <pageName></pageName>
            <odeNavStructureOrder>2</odeNavStructureOrder>
            <odePagStructures>
              <odePagStructure>
                <odeComponents>
                  <odeComponent>
                    <htmlView><![CDATA[<p>Second page</p>]]></htmlView>
                  </odeComponent>
                </odeComponents>
              </odePagStructure>
            </odePagStructures>
          </odeNavStructure>
        </odeNavStructures>
      </ode>`;
    const { document } = parseContentXml(xml);
    const pages = generateElpViewData(document);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({
      id: 'p1',
      title: 'Start Page'
    });
    expect(pages[1]).toMatchObject({
      id: 'p2',
      title: 'p2'
    });
  });

  test('concatenates htmlView contents for each page in document order', () => {
    const xml = `<?xml version="1.0"?>
      <ode>
        <odeNavStructures>
          <odeNavStructure>
            <odePageId>p1</odePageId>
            <pageName>Start Page</pageName>
            <odeNavStructureOrder>1</odeNavStructureOrder>
            <odePagStructures>
              <odePagStructure>
                <odeComponents>
                  <odeComponent>
                    <htmlView><![CDATA[<p>First block</p>]]></htmlView>
                  </odeComponent>
                  <odeComponent>
                    <htmlView><![CDATA[<p>Second block</p>]]></htmlView>
                  </odeComponent>
                </odeComponents>
              </odePagStructure>
            </odePagStructures>
          </odeNavStructure>
        </odeNavStructures>
      </ode>`;
    const { document } = parseContentXml(xml);
    const pages = generateElpViewData(document);
    expect(pages).toHaveLength(1);
    const { htmlContent } = pages[0];
    expect(htmlContent.includes('<p>First block</p>')).toBe(true);
    expect(htmlContent.includes('<p>Second block</p>')).toBe(true);
    expect(htmlContent.indexOf('<p>First block</p>')).toBeLessThan(htmlContent.indexOf('<p>Second block</p>'));
  });

  test('builds nested page structure when parent identifiers are present', () => {
    const xml = `<?xml version="1.0"?>
      <ode>
        <odeNavStructures>
          <odeNavStructure>
            <odePageId>root</odePageId>
            <pageName>Root</pageName>
            <odeNavStructureOrder>1</odeNavStructureOrder>
            <odePagStructures>
              <odePagStructure>
                <odeComponents>
                  <odeComponent>
                    <htmlView><![CDATA[<p>Root content</p>]]></htmlView>
                  </odeComponent>
                </odeComponents>
              </odePagStructure>
            </odePagStructures>
          </odeNavStructure>
          <odeNavStructure>
            <odePageId>child</odePageId>
            <pageName>Child</pageName>
            <odeNavStructureParent>root</odeNavStructureParent>
            <odeNavStructureOrder>2</odeNavStructureOrder>
            <odePagStructures>
              <odePagStructure>
                <odeComponents>
                  <odeComponent>
                    <htmlView><![CDATA[<p>Child content</p>]]></htmlView>
                  </odeComponent>
                </odeComponents>
              </odePagStructure>
            </odePagStructures>
          </odeNavStructure>
        </odeNavStructures>
      </ode>`;
    const { document } = parseContentXml(xml);
    const pages = generateElpViewData(document);
    expect(pages).toHaveLength(1);
    expect(pages[0].id).toBe('root');
    expect(Array.isArray(pages[0].children)).toBe(true);
    expect(pages[0].children).toHaveLength(1);
    expect(pages[0].children[0].id).toBe('child');
    expect(pages[0].children[0].title).toBe('Child');
  });

  test('handles legacy contentv3 manifests', () => {
    const legacyXml = `<?xml version="1.0"?>
      <instance xmlns="http://www.exelearning.org/content/v0.3" version="0.3" class="exe.engine.package.Package">
        <dictionary>
          <string role="key" value="_title"></string>
          <unicode value="Legacy package"></unicode>
          <string role="key" value="_children"></string>
          <list>
            <instance class="exe.engine.node.Node">
              <dictionary>
                <string role="key" value="_id"></string>
                <unicode value="legacy-page"></unicode>
                <string role="key" value="_title"></string>
                <unicode value="Legacy Page"></unicode>
                <string role="key" value="_children"></string>
                <list></list>
                <string role="key" value="_idevices"></string>
                <list>
                  <instance class="exe.engine.idevice.TextIdevice">
                    <dictionary>
                      <string role="key" value="_id"></string>
                      <unicode value="legacy-idevice"></unicode>
                      <string role="key" value="_content"></string>
                      <unicode value="&lt;p&gt;Legacy content&lt;/p&gt;"></unicode>
                    </dictionary>
                  </instance>
                </list>
              </dictionary>
            </instance>
          </list>
        </dictionary>
      </instance>`;
    const { document } = parseContentXml(legacyXml);
    const pages = generateElpViewData(document);
    expect(pages).toHaveLength(1);
    expect(pages[0].id).toBe('legacy-page');
    expect(pages[0].title).toBe('Legacy Page');
    expect(pages[0].htmlContent).toContain('<p>Legacy content</p>');
  });
});
