import { Buffer } from 'node:buffer';
import { ModelFactory } from '../source/omc.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ge } from '../source/om-proto.js';
import process from 'node:process';

const factory = new ModelFactory();
const compareTopGraph = (model, reference) => {
    const graph = model.modules[0];
    const expected = reference.graph[0];
    const ops = expected.op.filter((op) => !['Data', 'NetOutput', 'Const'].includes(op.type));
    assert.equal(graph.name, expected.name);
    assert.deepEqual(graph.nodes.map((node) => [node.name, node.type.identifier || node.type.name,
        node.inputs.map((input) => input.value[0].name)]), ops.map((op) => [op.name, op.type,
        op.input.filter((input) => input && !input.endsWith(':-1'))]));
    const inputs = expected.op.filter((op) => op.type === 'Data').flatMap((op) => op.output_desc.map((_, i) => `${op.name}:${i}`));
    assert.deepEqual(graph.inputs.map((input) => input.value[0].name), inputs);
    const outputs = expected.op.filter((op) => op.type === 'NetOutput').flatMap((op) => op.input.filter(Boolean));
    assert.deepEqual(graph.outputs.map((output) => output.value[0].name), outputs);
};

const verify = async (file, reference) => {
    const fd = fs.openSync(file, 'r');
    try {
        let bytesRead = 0;
        const stream = {
            length: fs.fstatSync(fd).size, position: 0,
            seek(position) {
                this.position = position;
            },
            peek(length) {
                assert(length !== undefined);
                const blob = Buffer.alloc(length);
                assert.equal(fs.readSync(fd, blob, 0, length, this.position), length);
                bytesRead += length;
                return blob;
            }
        };
        const context = { stream, require: async () => ({ ge }), metadata: async () => ({ type: () => null }), set: (value) => value };
        assert.equal(await factory.match(context), 'omc');
        const model = await factory.open(context);
        if (reference) {
            compareTopGraph(model, reference);
        }
        const modules = model.modules.map((graph) => {
            const outputs = new Set([...graph.inputs, ...graph.nodes.flatMap((node) => node.outputs)].flatMap((arg) => arg.value));
            let edges = 0;
            for (const arg of [...graph.outputs, ...graph.nodes.flatMap((node) => node.inputs)]) {
                for (const edge of arg.value) {
                    assert(outputs.has(edge) || edge.initializer, `Undefined input ${edge.name}`);
                    edges++;
                }
            }
            return { name: graph.name, nodes: graph.nodes.length, edges,
                inputs: graph.inputs.map((arg) => [arg.name, arg.value[0].type?.toString()]),
                outputs: graph.outputs.map((arg) => [arg.name, arg.value[0].type?.toString()]),
                operators: [...new Set(graph.nodes.map((node) => node.type.identifier || node.type.name))] };
        });
        assert(modules.length > 0);
        assert.equal(stream.position, 0);
        process.stdout.write(`${JSON.stringify({ file, format: model.format, bytesRead, fileSize: stream.length, modules })}\n`);
    } finally {
        fs.closeSync(fd);
    }
};

// Verify sequentially to keep memory bounded for full networks.
const args = process.argv.slice(2);
let reference = null;
if (args[0] === '--reference') {
    assert.equal(args.length, 3, 'Expected --reference OMG.json MODEL.omc');
    args.shift();
    reference = JSON.parse(fs.readFileSync(args.shift(), 'utf-8'));
}
assert(args.length, 'Expected at least one OMC file path.');
for (const file of args) {
    /* eslint-disable-next-line no-await-in-loop */
    await verify(file, reference);
}
