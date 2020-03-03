import { JsonController, Post } from '@flyacts/routing-controllers';
import { Service } from 'typedi';
import { Acl } from '../../../../src';

@Service()
@JsonController('/tata')
export class ValidateController {
	@Acl([{ action: 'createBar', user: '@' }])
	@Post()
	public async createBar(): Promise<void> {
		return;
	}
}
