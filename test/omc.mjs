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

// Check the dispatch graph against the actual shape table and task headers in the two-gear fixture.
const checkGears = (model, bytes) => {
    const [root, decode, decodeDevice, prefill, prefillDevice] = model.modules;
    assert.equal(bytes[82], 10);
    assert.deepEqual(model.modules.map((g) => g.name), ['enum_shape_main_graph', 'branches0', 'branches0/SubGraph_0',
        'branches1', 'branches1/SubGraph_0']);
    const [selector, dispatch] = root.nodes;
    assert.equal(selector.type.name, 'MapIndex');
    assert.equal(dispatch.type.name, 'Case');
    assert.deepEqual(dispatch.inputs.map((arg) => arg.value[0].name), ['enum_shape_graph/mapindex:0', 'x:0', 'shared_weight:0', 'state:0']);
    assert.equal(selector.outputs[0].value[0], dispatch.inputs[0].value[0]);
    assert.deepEqual(dispatch.attributes.filter((arg) => arg.type === 'graph').map((arg) => arg.value), [decode, prefill]);
    assert.equal(root.outputs[0].value[0], dispatch.outputs[0].value[0]);
    const table = Buffer.from(selector.inputs[1].value[0].initializer.values);
    const shapeGears = [];
    for (let i = 0; i < table.length; i += 4) {
        shapeGears.push(table.readInt32LE(i));
    }
    assert.deepEqual(shapeGears, [1, 1, 1, 16, 1, 1, 1, 16, 1, 1, 1, 16, 1, 1, 128, 16, 1, 1, 1, 16, 1, 1, 1, 16]);
    const start = bytes.readUInt32LE(4);
    const count = bytes.readUInt32LE(start);
    assert.equal(count, 3);
    const entry = start + 4 + 2 * 12;
    assert.equal(bytes.readUInt32LE(entry), 2);
    const taskStart = start + 4 + count * 12 + bytes.readUInt32LE(entry + 4);
    const taskLength = bytes.readUInt32LE(entry + 8);
    let cursor = 0;
    for (const [graph, device, tokens, weighted, expectedSize] of [
        [decode, decodeDevice, 1, 'Eltwise', 41000], [prefill, prefillDevice, 128, 'Mul', 51010]
    ]) {
        assert.deepEqual(graph.inputs[0].value[0].type.shape.dimensions, [1, 1, tokens, 16]);
        const call = graph.nodes.find((node) => node.type === device);
        const attrs = new Map(call.attributes.map((a) => [a.name, a.value]));
        assert.equal(Number(attrs.get('graphop_weight_offset')), 0);
        assert.equal(Number(attrs.get('graphop_weight_size')), 512);
        assert.equal(Number(attrs.get('graphop_task_offset')), cursor);
        assert.equal(Number(attrs.get('graphop_task_size')), expectedSize);
        assert.equal(bytes.readUInt32LE(taskStart + cursor), 0xabcdabcd);
        assert.equal(bytes.readUInt32LE(taskStart + cursor + 8), expectedSize);
        assert.equal(device.nodes.find((node) => node.name === 'weighted').type.name, weighted);
        cursor += expectedSize;
    }
    assert.equal(cursor, taskLength);
};

const verify = async (file, reference, gears) => {
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
        if (gears) {
            checkGears(model, fs.readFileSync(file));
        }
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
const gears = args[0] === '--phase-gears';
if (gears) {
    args.shift();
}
let reference = null;
if (args[0] === '--reference') {
    assert.equal(args.length, 3, 'Expected --reference OMG.json MODEL.omc');
    args.shift();
    reference = JSON.parse(fs.readFileSync(args.shift(), 'utf-8'));
}
assert(args.length, 'Expected at least one OMC file path.');
for (const file of args) {
    /* eslint-disable-next-line no-await-in-loop */
    await verify(file, reference, gears);
}
