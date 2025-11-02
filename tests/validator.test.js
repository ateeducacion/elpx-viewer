const {
    parseContentXml,
    checkRootElement,
    checkNavStructures,
    checkPagePresence,
    validateStructuralIntegrity,
    extractResourcePaths,
    findMissingResources,
    normalizeResourcePath,
    extractMetadata,
    extractLegacyMetadata,
    normalizeLegacyMetadata
} = require('../js/validator');

describe('ELP Validator helpers', () => {
    const minimalXml = `<?xml version="1.0"?>
    <ode>
        <odeNavStructures>
                <odeNavStructure>
                <odePageId>p1</odePageId>
                <pageName>Start</pageName>
                <odeNavStructureOrder>1</odeNavStructureOrder>
                <odePagStructures>
                    <odePagStructure>
                        <odeBlockId>b1</odeBlockId>
                        <blockName>Block</blockName>
                        <odeComponents>
                            <odeComponent>
                                <odeIdeviceId>c1</odeIdeviceId>
                                <odeIdeviceTypeName>TextIdevice</odeIdeviceTypeName>
                                <htmlView><![CDATA[<p>Content with <img src="content/images/pic.png"></p>]]></htmlView>
                                <jsonProperties>{"files":["content/images/pic.png"]}</jsonProperties>
                            </odeComponent>
                        </odeComponents>
                    </odePagStructure>
                </odePagStructures>
            </odeNavStructure>
        </odeNavStructures>
    </ode>`;

    test('parseContentXml reports malformed XML', () => {
        const malformed = '<ode><unclosed></ode>';
        const result = parseContentXml(malformed);
        expect(result.status).toBe('error');
        expect(result.message).toMatch(/not well-formed|error/i);
    });

    test('parseContentXml parses valid XML', () => {
        const result = parseContentXml(minimalXml);
        expect(result.status).toBe('success');
        expect(result.document).toBeDefined();
    });

    test('checkRootElement validates the <ode> element', () => {
        const { document } = parseContentXml(minimalXml);
        const result = checkRootElement(document);
        expect(result.status).toBe('success');
    });

    test('checkRootElement fails for unexpected root', () => {
        const xml = '<?xml version="1.0"?><root></root>';
        const { document } = parseContentXml(xml);
        const result = checkRootElement(document);
        expect(result.status).toBe('error');
        expect(result.message).toMatch(/expected the root element/i);
    });

    test('checkNavStructures fails when element missing', () => {
        const xml = '<?xml version="1.0"?><ode></ode>';
        const { document } = parseContentXml(xml);
        const result = checkNavStructures(document);
        expect(result.status).toBe('error');
    });

    test('checkPagePresence warns when there are no pages', () => {
        const xml = '<?xml version="1.0"?><ode><odeNavStructures></odeNavStructures></ode>';
        const { document } = parseContentXml(xml);
        const result = checkPagePresence(document);
        expect(result.status).toBe('warning');
    });

    test('validateStructuralIntegrity reports missing fields', () => {
        const xml = `<?xml version="1.0"?>
            <ode>
                <odeNavStructures>
                    <odeNavStructure>
                        <odePageId>p1</odePageId>
                        <odePagStructures>
                            <odePagStructure>
                                <odeComponents>
                                    <odeComponent>
                                        <odeIdeviceId>c1</odeIdeviceId>
                                    </odeComponent>
                                </odeComponents>
                            </odePagStructure>
                        </odePagStructures>
                    </odeNavStructure>
                </odeNavStructures>
            </ode>`;
        const { document } = parseContentXml(xml);
        const result = validateStructuralIntegrity(document);
        expect(result.status).toBe('error');
        expect(result.message).toMatch(/missing fields/i);
    });

    test('validateStructuralIntegrity succeeds for minimal valid XML', () => {
        const { document } = parseContentXml(minimalXml);
        const result = validateStructuralIntegrity(document);
        expect(result.status).toBe('success');
    });

    test('extractMetadata returns properties and resources maps', () => {
        const xml = `<?xml version="1.0"?>
            <ode>
                <odeProperties>
                    <odeProperty>
                        <key>pp_title</key>
                        <value>Sample title</value>
                    </odeProperty>
                    <odeProperty>
                        <key>pp_author</key>
                        <value>Author Name</value>
                    </odeProperty>
                </odeProperties>
                <odeResources>
                    <odeResource>
                        <key>odeVersionId</key>
                        <value>123</value>
                    </odeResource>
                </odeResources>
            </ode>`;
        const { document } = parseContentXml(xml);
        const metadata = extractMetadata(document);
        expect(metadata.properties.pp_title).toBe('Sample title');
        expect(metadata.properties.pp_author).toBe('Author Name');
        expect(metadata.resources.odeVersionId).toBe('123');
    });

    test('extractResourcePaths finds HTML and JSON references', () => {
        const { document } = parseContentXml(minimalXml);
        const resources = extractResourcePaths(document);
        expect(resources).toContain('content/images/pic.png');
        expect(resources.length).toBe(1);
    });

    test('findMissingResources identifies absent files', () => {
        const paths = ['content/images/pic.png'];
        const mockZip = {
            file: jest.fn().mockReturnValue(null)
        };
        const missing = findMissingResources(paths, mockZip);
        expect(missing).toEqual(paths);
    });

    test('findMissingResources ignores existing files', () => {
        const paths = ['content/images/pic.png'];
        const mockZip = {
            file: jest.fn((name) => (name === 'content/images/pic.png' ? {} : null))
        };
        const missing = findMissingResources(paths, mockZip);
        expect(missing).toHaveLength(0);
    });

    test('normalizeResourcePath cleans relative and encoded paths', () => {
        expect(normalizeResourcePath('./content/My%20File.png')).toBe('content/My File.png');
        expect(normalizeResourcePath('/custom\\file.txt')).toBe('custom/file.txt');
    });

    test('extractLegacyMetadata reads key/value pairs from legacy manifests', () => {
        const legacyXml = `<?xml version="1.0"?>
            <instance xmlns="http://www.exelearning.org/content/v0.3" version="0.3" class="exe.engine.package.Package">
                <dictionary>
                    <string role="key" value="_title"></string>
                    <unicode value="Legacy Title"></unicode>
                    <string role="key" value="_author"></string>
                    <unicode value="Legacy Author"></unicode>
                    <string role="key" value="_lang"></string>
                    <unicode value="es"></unicode>
                </dictionary>
            </instance>`;
        const { document } = parseContentXml(legacyXml);
        const metadata = extractLegacyMetadata(document);
        expect(metadata.properties._title).toBe('Legacy Title');
        expect(metadata.properties._author).toBe('Legacy Author');
        expect(metadata.properties.legacy_manifest_version).toBe('0.3');
    });

    test('normalizeLegacyMetadata maps legacy keys to modern equivalents', () => {
        const legacy = {
            properties: {
                _title: 'Legacy Title',
                _author: 'Legacy Author',
                _lang: 'es',
                _description: 'Legacy description',
                _newlicense: 'CC BY-SA'
            },
            resources: {}
        };
        const normalized = normalizeLegacyMetadata(legacy);
        expect(normalized.properties.pp_title).toBe('Legacy Title');
        expect(normalized.properties.pp_author).toBe('Legacy Author');
        expect(normalized.properties.pp_lang).toBe('es');
        expect(normalized.properties.pp_description).toBe('Legacy description');
        expect(normalized.properties.license).toBe('CC BY-SA');
    });
});
