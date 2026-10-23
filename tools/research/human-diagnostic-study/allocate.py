#!/usr/bin/env python3
"""Freeze randomized balanced allocation before enrollment, independently of outcomes."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import random
import secrets

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--participants',type=int,default=48);p.add_argument('--mode',choices=['formal','dry-run'],default='formal');p.add_argument('--seed',type=int);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    if a.participants<1:raise SystemExit('Positive participant count required')
    if a.output.exists():raise SystemExit('Refusing to replace frozen allocation')
    seed=a.seed if a.seed is not None else secrets.randbits(64);rng=random.Random(seed);block=12;slots=[]
    while len(slots)<a.participants:
        values=list(range(block));rng.shuffle(values);slots.extend(values)
    a.output.mkdir(parents=True)
    file=a.output/'PRIVATE-allocation.csv'
    with file.open('w',newline='') as stream:
        writer=csv.DictWriter(stream,fieldnames=['enrollmentOrder','participantId','allocationSlot','mode']);writer.writeheader()
        for i,slot in enumerate(slots[:a.participants]):writer.writerow({'enrollmentOrder':i+1,'participantId':f'P{i+1:03}','allocationSlot':slot,'mode':a.mode})
    receipt={'mode':a.mode,'participants':a.participants,'seed':seed,'blockSize':block,'completeBlocks':a.participants//block,'partialBlock':a.participants%block,'allocationSha256':hashlib.sha256(file.read_bytes()).hexdigest(),'scope':'Allocation preparation only; not recruitment or human data. Keep future slots concealed from participant-facing staff where practical.'}
    (a.output/'allocation-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))

if __name__=='__main__':main()
