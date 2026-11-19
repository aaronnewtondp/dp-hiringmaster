// The people who can be picked as an interviewer when scheduling a round (ScheduleRoundModal).
// Source: the Google Workspace admin user list pasted by Aaron on 2026-11-19. Kept in the app, not the database: it changes rarely, and a stale
// entry only means someone cannot be picked until this file is edited.
//
// Included: ACTIVE personal accounts on @digitalpaani.com. Left out on purpose:
//   - suspended accounts (a calendar invite to a suspended mailbox goes nowhere);
//   - shared / functional mailboxes (accounts@, hr@, sales@, support@, store@, commercial@ …) — nobody interviews as "Sales Team";
//     hr@digitalpaani.com is copied on every invite by the backend anyway;
//   - the @ecoinnovision.com duplicates (another domain; the invite is sent from the digitalpaani.com calendar).
// Emails are lower-case: the feedback gate compares them case-insensitively against the signed-in user's email.
export interface Interviewer { name: string; email: string }

export const INTERVIEWERS: readonly Interviewer[] = [
  { name: 'Aaron Newton', email: 'aaron.newton@digitalpaani.com' },
  { name: 'Abbas Shareif', email: 'abbas.shareif@digitalpaani.com' },
  { name: 'Abhinav Jain', email: 'abhinav.jain@digitalpaani.com' },
  { name: 'Abhishek Kumar', email: 'abhishek.kumar@digitalpaani.com' },
  { name: 'Abhishek Yadav', email: 'abhishek.yadav@digitalpaani.com' },
  { name: 'Ahmad Akhtar', email: 'ahmad.akhtar@digitalpaani.com' },
  { name: 'Akash Sharma', email: 'akash.sharma@digitalpaani.com' },
  { name: 'Alexander Loijos', email: 'alex.loijos@digitalpaani.com' },
  { name: 'Alisha Sonwane', email: 'alisha.sonwane@digitalpaani.com' },
  { name: 'Amit Gosain', email: 'amit.gosain@digitalpaani.com' },
  { name: 'Azharul Haque', email: 'azharul.haque@digitalpaani.com' },
  { name: 'Babloo Mashi', email: 'babloo.mashi@digitalpaani.com' },
  { name: 'Deeksha Chaturvedi', email: 'deeksha.chaturvedi@digitalpaani.com' },
  { name: 'Deepak Verma', email: 'deepak.verma@digitalpaani.com' },
  { name: 'Devid Rajput', email: 'devid.rajput@digitalpaani.com' },
  { name: 'Dinesh Mani', email: 'dinesh.mani@digitalpaani.com' },
  { name: 'Divyam', email: 'divyam@digitalpaani.com' },
  { name: 'Garima Bhurtia', email: 'garima.bhurtia@digitalpaani.com' },
  { name: 'Garvit Kumar', email: 'garvit.kumar@digitalpaani.com' },
  { name: 'Himanshu Rana', email: 'himanshu.rana@digitalpaani.com' },
  { name: 'Jinal Gayakwad', email: 'jinal.gayakwad@digitalpaani.com' },
  { name: 'Laxman Prasad', email: 'laxman.prasad@digitalpaani.com' },
  { name: 'Leon Louis', email: 'leon.louis@digitalpaani.com' },
  { name: 'Mandeep Dagar', email: 'mandeep.dagar@digitalpaani.com' },
  { name: 'Mansi Jain', email: 'mansi.jain@digitalpaani.com' },
  { name: 'Mihir Sethi', email: 'mihir.sethi@digitalpaani.com' },
  { name: 'Mohazzib Khan', email: 'mohazzib.khan@digitalpaani.com' },
  { name: 'Mohit Joshi', email: 'mohit.joshi@digitalpaani.com' },
  { name: 'Nagendra Sharma', email: 'nagendra.sharma@digitalpaani.com' },
  { name: 'Neeraj Kumar', email: 'neeraj.kumar@digitalpaani.com' },
  { name: 'Nikhil Rai', email: 'nikhil.rai@digitalpaani.com' },
  { name: 'Nikhil Sharma', email: 'nikhil.sharma@digitalpaani.com' },
  { name: 'Nitin Sharma', email: 'nitin.sharma@digitalpaani.com' },
  { name: 'Paresh Dhamankar', email: 'paresh.dhamankar@digitalpaani.com' },
  { name: 'Pepe Bolorinos', email: 'pepe.bolorinos@digitalpaani.com' },
  { name: 'Piyush Negi', email: 'piyush.negi@digitalpaani.com' },
  { name: 'Prabhaker Sinha', email: 'prabhaker.sinha@digitalpaani.com' },
  { name: 'Prakhar Jain', email: 'prakhar.jain@digitalpaani.com' },
  { name: 'Preeti Kuhad', email: 'preeti.kuhad@digitalpaani.com' },
  { name: 'Prince Kumar', email: 'prince.kumar@digitalpaani.com' },
  { name: 'Priyanka Ghlyan', email: 'priyanka.ghlyan@digitalpaani.com' },
  { name: 'Priyanka Khaire', email: 'priyanka.khaire@digitalpaani.com' },
  { name: 'Rajesh Jain', email: 'rajesh.jain@digitalpaani.com' },
  { name: 'Ram Aggarwal', email: 'ram.aggarwal@digitalpaani.com' },
  { name: 'Ramendra Singh', email: 'ramendra.singh@digitalpaani.com' },
  { name: 'Reman Sharma', email: 'reman.sharma@digitalpaani.com' },
  { name: 'Ria Sontakke', email: 'ria.sontakke@digitalpaani.com' },
  { name: 'Ritvik Kalra', email: 'ritvik.kalra@digitalpaani.com' },
  { name: 'Sachin Kumar', email: 'sachin.kumar@digitalpaani.com' },
  { name: 'Saikat Swarnakar', email: 'saikat.swarnakar@digitalpaani.com' },
  { name: 'Satyadev Singh', email: 'satyadev.singh@digitalpaani.com' },
  { name: 'Shahrukh Khan', email: 'shahrukh.khan@digitalpaani.com' },
  { name: 'Shejal Admane', email: 'shejal.admane@digitalpaani.com' },
  { name: 'Shivam Jisorya', email: 'shivam.jisorya@digitalpaani.com' },
  { name: 'Shoaib Sayyed', email: 'shoaib.sayyed@digitalpaani.com' },
  { name: 'Siddharth Kumar', email: 'siddharth@digitalpaani.com' },
  { name: 'Sonia Patel', email: 'sonia@digitalpaani.com' },
  { name: 'Sudhir Kumar', email: 'sudhir.kumar@digitalpaani.com' },
  { name: 'Sunny Kumar', email: 'sunny.kumar@digitalpaani.com' },
  { name: 'Swadesh Bharati', email: 'swadesh.bharati@digitalpaani.com' },
  { name: 'Tanya Garg', email: 'tanya.garg@digitalpaani.com' },
  { name: 'Tikam Singh', email: 'tikam.singh@digitalpaani.com' },
  { name: 'Trisha Goenka', email: 'trisha@digitalpaani.com' },
  { name: 'Vibhanshu Vaibhav', email: 'vibhanshu.vaibhav@digitalpaani.com' },
  { name: 'Vikash Kumar', email: 'vikash.kumar@digitalpaani.com' },
  { name: 'Vinayak Sharma', email: 'vinayak.sharma@digitalpaani.com' },
  { name: 'Vivek Kumar', email: 'vivek.kumar@digitalpaani.com' },
  { name: 'Yakshrat Nanda', email: 'yakshrat.nanda@digitalpaani.com' },
  { name: 'Yogesh Gayakwad', email: 'yogesh.gayakwad@digitalpaani.com' },
];

/** Case-insensitive match on name or email; an empty query matches everyone. */
export function filterInterviewers(list: readonly Interviewer[], query: string): Interviewer[] {
  const q = query.trim().toLowerCase();
  return q ? list.filter(p => p.name.toLowerCase().includes(q) || p.email.includes(q)) : [...list];
}
