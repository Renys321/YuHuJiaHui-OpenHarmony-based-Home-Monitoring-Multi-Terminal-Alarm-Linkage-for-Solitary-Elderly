/**
 * 紧急联系人管理页（本机编辑；服务端联系人接口只读）
 */
import { Color, FontSize, FontWeight_, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { NavBar } from '../components/NavBar';
import { ContactsLocal } from '../common/ContactsLocal';
import { MockData } from '../common/MockData';
import { EmergencyContact } from '../model/Elder';

@Entry
@Component
struct ContactsEditPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @State contacts: EmergencyContact[] = [];
  @State saving: boolean = false;

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  aboutToAppear(): void {
    const override = AppStorage.get<EmergencyContact[]>('gv.contactsOverride');
    if (override !== undefined && override !== null) {
      this.contacts = override;
      return;
    }
    const ctx = this.getUIContext().getHostContext();
    if (ctx !== undefined) {
      ContactsLocal.load(ctx).then((list: EmergencyContact[] | null) => {
        if (list !== null) {
          this.contacts = list;
          AppStorage.setOrCreate<EmergencyContact[]>('gv.contactsOverride', list);
        } else {
          this.contacts = MockData.elder().emergencyContacts;
        }
      });
    } else {
      this.contacts = MockData.elder().emergencyContacts;
    }
  }

  private addContact(): void {
    const c = new EmergencyContact();
    c.id = `local_${Date.now()}`;
    c.name = '';
    c.relation = '';
    c.phone = '';
    c.priority = this.contacts.length + 1;
    c.notifyEnabled = true;
    this.contacts.push(c);
  }

  private removeAt(index: number): void {
    this.contacts.splice(index, 1);
  }

  private save(): void {
    if (this.saving) return;
    const out: EmergencyContact[] = [];
    for (let i = 0; i < this.contacts.length; i++) {
      const c = this.contacts[i];
      if (c.name.trim().length === 0 && c.phone.trim().length === 0) continue;
      const item = new EmergencyContact();
      item.id = c.id;
      item.name = c.name.trim();
      item.relation = c.relation.trim();
      item.phone = c.phone.trim();
      item.priority = i + 1;
      item.notifyEnabled = c.notifyEnabled;
      out.push(item);
    }
    const ctx = this.getUIContext().getHostContext();
    AppStorage.setOrCreate<EmergencyContact[]>('gv.contactsOverride', out);
    AppStorage.setOrCreate<number>('gv.elderRevision', Date.now());
    this.saving = true;
    if (ctx === undefined) {
      this.saving = false;
      this.getUIContext().getRouter().back();
      return;
    }
    ContactsLocal.save(ctx, out).then(() => {
      this.saving = false;
      this.getUIContext().getPromptAction().showToast({ message: '联系人已保存（仅本机）' });
      this.getUIContext().getRouter().back();
    }).catch(() => {
      this.saving = false;
      this.getUIContext().getPromptAction().showToast({ message: '保存失败，请重试' });
    });
  }

  @Builder
  contactCard(c: EmergencyContact, index: number) {
    Column() {
      Row() {
        Text(`联系人 ${index + 1}`)
          .fontSize(FontSize.caption)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textSecondary)
        Blank()
        Text('删除')
          .fontSize(FontSize.caption)
          .fontColor(Color.criticalDark)
          .onClick(() => { this.removeAt(index); })
      }
      .width('100%')
      .margin({ bottom: 6 })

      TextInput({ placeholder: '姓名', text: c.name })
        .fontSize(FontSize.body)
        .backgroundColor('#F8FAFC')
        .borderRadius(Radius.button)
        .border({ width: 1, color: Color.border })
        .height(44)
        .margin({ bottom: 6 })
        .onChange((v: string) => { c.name = v; })
      TextInput({ placeholder: '关系，例如 儿子/女儿/邻居', text: c.relation })
        .fontSize(FontSize.body)
        .backgroundColor('#F8FAFC')
        .borderRadius(Radius.button)
        .border({ width: 1, color: Color.border })
        .height(44)
        .margin({ bottom: 6 })
        .onChange((v: string) => { c.relation = v; })
      TextInput({ placeholder: '手机号', text: c.phone })
        .type(InputType.PhoneNumber)
        .maxLength(11)
        .fontSize(FontSize.body)
        .backgroundColor('#F8FAFC')
        .borderRadius(Radius.button)
        .border({ width: 1, color: Color.border })
        .height(44)
        .onChange((v: string) => { c.phone = v; })
    }
    .width('100%')
    .padding(Space.md)
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .margin({ bottom: Space.md })
  }

  build() {
    Column() {
      NavBar({ title: '紧急联系人', showBack: true, rightText: '保存',
        onRight: () => { this.save(); } })
      Scroll() {
        Column() {
          Text('服务端联系人接口为只读；此处修改仅保存在本机，用于展示与联系提醒。')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .lineHeight(17)
            .width('100%')
            .padding(Space.md)
            .backgroundColor('#EFF6FF')
            .borderRadius(Radius.chip)
            .margin({ bottom: Space.md })

          ForEach(this.contacts, (c: EmergencyContact, i: number) => {
            this.contactCard(c, i)
          }, (c: EmergencyContact) => c.id)

          Button('+ 添加联系人')
            .width('100%')
            .height(46)
            .fontSize(FontSize.body)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.primaryDark)
            .backgroundColor('#E0F2FE')
            .borderRadius(Radius.button)
            .margin({ bottom: Space.md })
            .onClick(() => { this.addContact(); })

          Button(this.saving ? '保存中…' : '保存联系人')
            .width('100%')
            .height(48)
            .fontSize(FontSize.h3)
            .fontWeight(FontWeight_.bold)
            .fontColor('#FFFFFF')
            .backgroundColor(Color.primary)
            .borderRadius(Radius.button)
            .enabled(!this.saving)
            .onClick(() => { this.save(); })
        }
        .width('100%')
        .padding({ left: this.pm(), right: this.pm(), top: Space.md, bottom: Space.xxl })
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
