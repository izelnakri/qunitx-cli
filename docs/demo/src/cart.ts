export interface Item {
  name: string;
  price: number;
  qty?: number;
}

export class Cart {
  items: Required<Item>[] = [];

  add(item: Item): this {
    this.items.push({ qty: 1, ...item });
    return this;
  }

  remove(name: string): this {
    this.items = this.items.filter((item) => item.name !== name);
    return this;
  }

  get total(): number {
    return this.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  }

  render(): HTMLElement {
    const list = document.createElement('ul');
    for (const { name, qty } of this.items) {
      list.append(Object.assign(document.createElement('li'), { textContent: `${qty} × ${name}` }));
    }
    return list;
  }
}
