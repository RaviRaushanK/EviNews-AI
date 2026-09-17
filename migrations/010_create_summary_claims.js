'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('summary_claims', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the summary-claim link'
      },
      summary_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'summaries', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to summaries.id'
      },
      claim_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'claims', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to claims.id'
      },
      verification_status: {
        type: Sequelize.ENUM('supported', 'partially_supported', 'conflicting', 'unsupported'),
        allowNull: false,
        defaultValue: 'unsupported',
        comment: 'Verification status of the claim within the summary'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    await queryInterface.addIndex('summary_claims', ['summary_id'], {
      name: 'idx_summary_claims_summary_id'
    });
    await queryInterface.addIndex('summary_claims', ['claim_id'], {
      name: 'idx_summary_claims_claim_id'
    });
    await queryInterface.addIndex('summary_claims', ['summary_id', 'claim_id'], {
      name: 'idx_summary_claims_unique',
      unique: true
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('summary_claims');
  }
};